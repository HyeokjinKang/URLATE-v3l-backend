import signale from "signale";

import { knex } from "../db";
import { evaluateJudges, parseJudgeString } from "../judgement";
import { rebuild as rebuildRatingIndex } from "../rating-index";
import { redisClient } from "../redis";

const MEDAL_CLEAR = 1;
const CACHE_PATTERNS = ["cache:v1:*", "cachegrp:v1:*"];

const apply = process.argv.includes("--apply");

interface RecordRow {
  index: string;
  filename: string;
  difficulty: number;
  record: number;
  judge: string;
  accuracy: number;
  rank: string;
  medal: number;
  isBest: number;
  rating: number;
  date: Date;
}

interface Stats {
  users: number;
  records: number;
  changedRecords: number;
  unparsedJudges: number;
  rankChanges: number;
  clearChanges: number;
  missingDifficulty: number;
}

const stats: Stats = {
  users: 0,
  records: 0,
  changedRecords: 0,
  unparsedJudges: 0,
  rankChanges: 0,
  clearChanges: 0,
  missingDifficulty: 0,
};

class DryRun extends Error {}

const loadDifficulties = async () => {
  const difficulties = new Map<string, number[]>();
  const tracks = await knex("tracks").select("fileName", "difficulty");
  for (const track of tracks) {
    try {
      const arr = JSON.parse(track.difficulty);
      if (Array.isArray(arr)) difficulties.set(track.fileName, arr.map(Number));
    } catch {
      continue;
    }
  }
  return difficulties;
};

const recalculateUser = async (
  nickname: string,
  difficulties: Map<string, number[]>,
) => {
  await knex
    .transaction(async (trx) => {
      const [user] = await trx("users")
        .where("nickname", nickname)
        .select("rating", "accuracy", "playtime", "clear")
        .forUpdate();
      if (!user) return;

      const rows: RecordRow[] = await trx("trackRecords")
        .where("nickname", nickname)
        .select(
          "index",
          "filename",
          "difficulty",
          "record",
          "judge",
          "accuracy",
          "rank",
          "medal",
          "isBest",
          "rating",
          "date",
        )
        .orderBy("date", "asc");

      const updates = new Map<string, Partial<RecordRow>>();
      const groups = new Map<string, { row: RecordRow; rating: number }[]>();
      let accuracyDelta = 0;
      let clearDelta = 0;

      for (const row of rows) {
        stats.records++;
        const counts = parseJudgeString(row.judge);
        if (!counts) {
          stats.unparsedJudges++;
          continue;
        }
        const { accuracy, rank } = evaluateJudges(counts);
        const oldMedal = Number(row.medal);
        const medal =
          rank == "F" ? oldMedal & ~MEDAL_CLEAR : oldMedal | MEDAL_CLEAR;
        accuracyDelta += accuracy - Number(row.accuracy);
        if (rank != row.rank) stats.rankChanges++;
        if (medal != oldMedal) {
          stats.clearChanges++;
          if (Number(row.isBest) == 1) {
            clearDelta += (medal & MEDAL_CLEAR) - (oldMedal & MEDAL_CLEAR);
          }
        }
        if (
          accuracy != Number(row.accuracy) ||
          rank != row.rank ||
          medal != oldMedal
        ) {
          updates.set(row.index, { accuracy, rank, medal });
        }

        const difficultyValue = difficulties.get(row.filename)?.[
          Number(row.difficulty) - 1
        ];
        const groupKey = `${row.filename}\n${row.difficulty}`;
        if (!Number.isFinite(difficultyValue)) {
          stats.missingDifficulty++;
          groups.set(groupKey, []);
          continue;
        }
        const rating = Math.round(
          (Number(row.record) / 100000000) * accuracy * Number(difficultyValue),
        );
        if (!groups.has(groupKey)) groups.set(groupKey, []);
        groups.get(groupKey)?.push({ row, rating });
      }

      let ratingDelta = 0;
      for (const entries of groups.values()) {
        if (!entries.length) continue;
        const [first] = entries;
        const groupRows = rows.filter(
          (row) =>
            row.filename == first.row.filename &&
            row.difficulty == first.row.difficulty,
        );
        if (groupRows.length != entries.length) continue;
        let best = entries[0];
        for (const entry of entries) {
          if (entry.rating > best.rating) best = entry;
          else if (
            entry.rating == best.rating &&
            Number(entry.row.rating) > 0 &&
            Number(best.row.rating) == 0
          ) {
            best = entry;
          }
        }
        for (const entry of entries) {
          const rating = entry === best ? entry.rating : 0;
          const oldRating = Number(entry.row.rating);
          ratingDelta += rating - oldRating;
          if (rating != oldRating) {
            updates.set(entry.row.index, {
              ...updates.get(entry.row.index),
              rating,
            });
          }
        }
      }

      for (const [index, update] of updates) {
        await trx("trackRecords").where("index", index).update(update);
      }
      stats.changedRecords += updates.size;

      const playtime = Number(user.playtime);
      await trx("users")
        .where("nickname", nickname)
        .update({
          rating: Number(user.rating) + ratingDelta,
          accuracy:
            playtime > 0
              ? (
                  Math.round(
                    ((Number(user.accuracy) * playtime + accuracyDelta) * 100) /
                      playtime,
                  ) / 100
                ).toFixed(2)
              : user.accuracy,
          clear: Number(user.clear) + clearDelta,
        });
      stats.users++;

      if (!apply) throw new DryRun();
    })
    .catch((err) => {
      if (!(err instanceof DryRun)) throw err;
    });
};

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
  const difficulties = await loadDifficulties();
  const users = await knex("users").select("nickname");
  for (const { nickname } of users) {
    await recalculateUser(nickname, difficulties);
  }
  signale.info(stats);

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
