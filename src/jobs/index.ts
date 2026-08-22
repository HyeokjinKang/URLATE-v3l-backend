import schedule from "node-schedule";
import signale from "signale";

import { observer } from "../achievements";
import { knex } from "../db";
import { acquireDailyJobLock } from "../job-lock";
import { rebuild as rebuildRatingIndex } from "../rating-index";
import { cleanupReplayLogs } from "../replay-log";
import { parseJson } from "../validate";

const updateRankHistory = async () => {
  // A scheduled callback has no caller to catch its exceptions, so an error
  // here becomes an unhandledRejection.
  try {
    // Prevent duplicate recording across instances.
    if (!(await acquireDailyJobLock("rank-history"))) return;
    signale.info(new Date());
    signale.pending(`Updating rank history...`);
    const users = await knex("users")
      .select("userid", "rankHistory", "rating")
      .orderBy("rating", "desc");
    // Corrects any drift that incremental updates might have missed, once a day.
    await rebuildRatingIndex(users);
    for (let i = 0; i < users.length; i++) {
      // Prevents one user's corrupted value from stopping the whole job.
      const previous = parseJson(users[i].rankHistory);
      const history = [...(Array.isArray(previous) ? previous : []), i + 1];
      await knex("users")
        .update({ rankHistory: JSON.stringify(history.slice(-19)) })
        .where("userid", users[i].userid);
      let rank100 = false,
        rank50 = false,
        rank10 = false,
        rank1 = false;
      if (i < 100) {
        rank100 = true;
        if (i < 50) {
          rank50 = true;
          if (i < 10) {
            rank10 = true;
            if (i < 1) {
              rank1 = true;
            }
          }
        }
      }
      // Processed sequentially so this doesn't flood the pool (max 7) with one query per user.
      await observer(`${users[i].userid}`, "RANK", {
        rank100,
        rank50,
        rank10,
        rank1,
      });
    }
    signale.info(new Date());
    signale.success(`Rank history updated.`);
  } catch (err) {
    signale.error(`Failed to update rank history.`);
    signale.error(err);
  }
};

// Cleans up replay logs past their retention period, daily.
const cleanupLogs = async () => {
  try {
    if (!(await acquireDailyJobLock("replay-log-cleanup"))) return;
    await cleanupReplayLogs();
  } catch (err) {
    signale.error(err);
  }
};

// Called explicitly at startup rather than scheduled as an import side effect.
export const scheduleJobs = () => {
  schedule.scheduleJob("59 23 * * *", updateRankHistory);
  schedule.scheduleJob("30 4 * * *", cleanupLogs);
};
