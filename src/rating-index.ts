import signale from "signale";

import { isRedisReady, redisClient } from "./redis";

const RATING_KEY = "index:v1:rank:rating";
const BUILD_KEY = `${RATING_KEY}:building`;
const LOCK_KEY = `${RATING_KEY}:lock`;
const LOCK_TTL = 120;
const CHUNK_SIZE = 1000;

export interface RatingRow {
  userid: string | number;
  rating: string | number;
}

const toMembers = (rows: RatingRow[]) =>
  rows.map((row) => ({
    score: Number(row.rating) || 0,
    value: String(row.userid),
  }));

export const setRating = async (userid: string | number, rating: number) => {
  if (!isRedisReady()) return;
  try {
    await redisClient.zAdd(RATING_KEY, {
      score: Number(rating) || 0,
      value: String(userid),
    });
  } catch (err) {
    signale.error(err);
  }
};

// Rebuilds the index. Loads into a temp key and swaps it in with RENAME, so
// the existing index keeps serving traffic while the rebuild is in progress.
export const rebuild = async (rows: RatingRow[]) => {
  if (!isRedisReady() || !rows.length) return;
  try {
    await redisClient.del(BUILD_KEY);
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      await redisClient.zAdd(
        BUILD_KEY,
        toMembers(rows.slice(i, i + CHUNK_SIZE)),
      );
    }
    await redisClient.rename(BUILD_KEY, RATING_KEY);
    signale.success(`Rating index rebuilt with ${rows.length} users.`);
  } catch (err) {
    signale.error(err);
  }
};

export const countHigherRating = async (
  rating: number,
): Promise<number | null> => {
  if (!isRedisReady() || !Number.isFinite(rating)) return null;
  try {
    // ZCOUNT alone can't tell "index is empty" from "rank 1". Issued together
    // so node-redis pipelines them into one round trip.
    const [size, higher] = await Promise.all([
      redisClient.zCard(RATING_KEY),
      redisClient.zCount(RATING_KEY, `(${rating}`, "+inf"),
    ]);
    if (size === 0) return null;
    return higher;
  } catch (err) {
    signale.error(err);
    return null;
  }
};

export const acquireRebuildLock = async (): Promise<boolean> => {
  if (!isRedisReady()) return false;
  try {
    const result = await redisClient.set(LOCK_KEY, "1", {
      NX: true,
      EX: LOCK_TTL,
    });
    return result === "OK";
  } catch (err) {
    signale.error(err);
    return false;
  }
};

export const releaseRebuildLock = async () => {
  if (!isRedisReady()) return;
  try {
    await redisClient.del(LOCK_KEY);
  } catch (err) {
    signale.error(err);
  }
};
