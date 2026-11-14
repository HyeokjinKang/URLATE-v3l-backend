import signale from "signale";

import { knex } from "../db";
import {
  acquireRebuildLock,
  rebuild as rebuildRatingIndex,
  releaseRebuildLock,
} from "../rating-index";

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
