import signale from "signale";

import { isRedisReady, redisClient } from "./redis";

// rating 기준 전체 순위를 담는 Sorted Set입니다. 순위 계산이 O(log N)이 됩니다.
const RATING_KEY = "index:v1:rank:rating";
const BUILD_KEY = `${RATING_KEY}:building`;
const LOCK_KEY = `${RATING_KEY}:lock`;
// 재구축 도중 프로세스가 죽어도 락이 남지 않도록 하는 만료 시간(초)입니다.
const LOCK_TTL = 120;
// ZADD 한 번에 보내는 최대 멤버 수입니다.
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

// rating이 바뀔 때 호출합니다.
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

// 인덱스를 다시 만듭니다. 임시 키에 적재한 뒤 RENAME으로 교체하므로
// 재구축 중에도 기존 인덱스가 계속 서비스됩니다.
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

/**
 * 주어진 rating보다 높은 유저 수를 셉니다. COUNT(*) WHERE rating > ? 와 같은
 * 의미라 동점자 처리도 동일합니다. 인덱스가 비었거나 오류면 null을 돌려주고
 * 호출부가 DB로 폴백합니다.
 */
export const countHigherRating = async (
  rating: number,
): Promise<number | null> => {
  if (!isRedisReady() || !Number.isFinite(rating)) return null;
  try {
    // ZCOUNT만으로는 "인덱스가 비었음"과 "1위"를 구분할 수 없어 ZCARD가 함께
    // 필요합니다. 같은 틱에 내보내 node-redis가 한 번의 왕복으로 묶게 합니다.
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

// 재구축 락입니다. 여러 인스턴스가 동시에 users 전체를 읽는 것을 막습니다.
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
