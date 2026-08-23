import signale from "signale";

import { knex } from "../db";
import {
  acquireRebuildLock,
  rebuild as rebuildRatingIndex,
  releaseRebuildLock,
} from "../rating-index";

// Rebuilds the rating index on first boot or after a Redis restart. Even on
// success, the lock is left to expire naturally so a burst of full-users
// queries can't pile up while the index is still empty.
export const rebuildRatingIndexIfNeeded = async () => {
  if (!(await acquireRebuildLock())) return;
  try {
    const users = await knex("users").select("userid", "rating");
    await rebuildRatingIndex(users);
  } catch (err) {
    signale.error(err);
    await releaseRebuildLock();
  }
};
