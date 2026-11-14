import signale from "signale";

import { knex } from "../db";
import { rebuild as rebuildRatingIndex } from "../rating-index";
import { redisClient } from "../redis";

const CACHE_PATTERNS = ["cache:v1:*", "cachegrp:v1:*"];

const apply = process.argv.includes("--apply");

const clearCaches = async () => {
  for (const pattern of CACHE_PATTERNS) {
    for await (const batch of redisClient.scanIterator({
      MATCH: pattern,
      COUNT: 1000,
    })) {
      if (batch.length) await redisClient.del(batch);
    }
  }
};

const main = async () => {
  signale.info(apply ? "Applying changes." : "Dry run. Pass --apply to write.");
  const users = await knex("users").select("nickname");
  let changed = 0;
  let inflation = 0;
  for (const { nickname } of users) {
    await knex.transaction(async (trx) => {
      const [user] = await trx("users")
        .where("nickname", nickname)
        .select("rating")
        .forUpdate();
      if (!user) return;
      const [{ total }] = await trx("trackRecords")
        .where("nickname", nickname)
        .sum({ total: "rating" });
      const rating = Number(total) || 0;
      if (rating == Number(user.rating)) return;
      changed++;
      inflation += Number(user.rating) - rating;
      if (apply) {
        await trx("users").where("nickname", nickname).update({ rating });
      }
    });
  }
  signale.info({ users: users.length, changed, inflation });

  if (apply) {
    await redisClient.connect();
    await rebuildRatingIndex(await knex("users").select("userid", "rating"));
    await clearCaches();
    redisClient.destroy();
    signale.success("Rating index rebuilt and caches cleared.");
  }
};

main()
  .catch((err) => {
    signale.error(err);
    process.exitCode = 1;
  })
  .finally(() => knex.destroy());
