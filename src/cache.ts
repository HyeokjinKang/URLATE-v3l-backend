import { createHash } from "crypto";
import signale from "signale";

import config from "./config";
import { isRedisReady, redisClient } from "./redis";

const PREFIX = "cache:v1:";
const GROUP_PREFIX = "cachegrp:v1:";

const DEFAULT_TTL = {
  tracks: 600,
  trackInfo: 600,
  teamProfile: 600,
  notice: 300,
  user: 300,
  authStatus: 1800,
  profilePic: 300,
  bestRecord: 300,
  record: 60,
  leaderboard: 60,
  ranking: 60,
  profile: 30,
  achievements: 3600,
};

export type CacheKind = keyof typeof DEFAULT_TTL;

const cacheConfig = config.cache ?? {};
const cacheEnabled = cacheConfig.enabled ?? true;

export const ttlOf = (kind: CacheKind): number => {
  const configured = cacheConfig.ttl?.[kind];
  if (
    typeof configured === "number" &&
    Number.isFinite(configured) &&
    configured > 0
  ) {
    return Math.floor(configured);
  }
  return DEFAULT_TTL[kind];
};

const isUsable = (): boolean => cacheEnabled && isRedisReady();

const isSafeKeySegment = (value: string): boolean =>
  /^[A-Za-z0-9_.-]{1,128}$/.test(value);

// Unsafe input becomes a fixed-length hash, preventing delimiter (:) injection
// and unbounded key length.
export const safeSegment = (value: string | number): string => {
  const str = String(value);
  return isSafeKeySegment(str)
    ? str
    : "h_" + createHash("sha256").update(str).digest("hex").slice(0, 24);
};

const seg = safeSegment;

export const keys = {
  tracksAll: () => "tracks:all",
  track: (name: string) => `track:${seg(name)}`,
  trackInfo: (filename: string) => `trackinfo:${seg(filename)}`,
  notices: (lang: string) => `notices:${seg(lang)}`,
  teamProfile: (name: string) => `team:${seg(name)}`,
  profilePic: (nickname: string) => `pic:${seg(nickname)}`,
  useridByNickname: (nickname: string) => `uidof:${seg(nickname)}`,
  user: (userid: string) => `user:${seg(userid)}`,
  authStatus: (userid: string) => `authstatus:${seg(userid)}`,
  profile: (userid: string) => `profile:${seg(userid)}`,
  bestRecord: (nickname: string, filename: string) =>
    `bestrec:${seg(nickname)}:${seg(filename)}`,
  bestRecords: (nickname: string) => `bestrecs:${seg(nickname)}`,
  trackRecords: (nickname: string) => `trackrecs:${seg(nickname)}`,
  recentPlays: (userid: string) => `recentplays:${seg(userid)}`,
  record: (index: string) => `record:${seg(index)}`,
  ranking: (sort: string) => `ranking:${seg(sort)}`,
  achievement: (index: number) => `achievement:${seg(index)}`,
  leaderboard: (
    filename: string,
    difficulty: string | number,
    order: string,
    sort: string,
  ) => `board:${seg(filename)}:${seg(difficulty)}:${seg(order)}:${seg(sort)}`,
  leaderboardRank: (
    filename: string,
    difficulty: string | number,
    order: string,
    sort: string,
    nickname: string,
  ) =>
    `board:${seg(filename)}:${seg(difficulty)}:${seg(order)}:${seg(sort)}:rank:${seg(nickname)}`,
  leaderboardGroup: (filename: string, difficulty: string | number) =>
    `board:${seg(filename)}:${seg(difficulty)}`,
};

interface GetOrSetOptions {
  group?: string;
  cacheEmpty?: boolean;
}

const LOCK_PREFIX = "cachelock:v1:";
const FILL_LOCK_TTL_SEC = 10;
const FILL_WAIT_TOTAL_MS = 300;
const FILL_WAIT_INTERVAL_MS = 30;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Cache-aside lookup; falls back to the DB if Redis is down. On a miss, only the
// lock holder queries the DB and the rest wait briefly, preventing a thundering
// herd when a hot key expires.
export const getOrSet = async <T>(
  kind: CacheKind,
  key: string,
  fetcher: () => Promise<T>,
  options: GetOrSetOptions = {},
): Promise<T> => {
  if (!isUsable()) return fetcher();

  const fullKey = PREFIX + key;
  const read = async (): Promise<{ hit: boolean; value?: T }> => {
    const cached = await redisClient.get(fullKey);
    if (cached === null) return { hit: false };
    return { hit: true, value: JSON.parse(cached) as T };
  };

  let holdsLock = false;
  try {
    try {
      const first = await read();
      if (first.hit) return first.value as T;

      holdsLock =
        (await redisClient.set(LOCK_PREFIX + key, "1", {
          NX: true,
          EX: FILL_LOCK_TTL_SEC,
        })) === "OK";

      if (!holdsLock) {
        const deadline = Date.now() + FILL_WAIT_TOTAL_MS;
        while (Date.now() < deadline) {
          await sleep(FILL_WAIT_INTERVAL_MS);
          const retry = await read();
          if (retry.hit) return retry.value as T;
        }
      }
    } catch (err) {
      signale.error(err);
      return await fetcher();
    }

    const value = await fetcher();
    // Don't cache null/undefined: a "lookup failed" result would stick for the TTL.
    if (value === null || value === undefined) return value;
    if (options.cacheEmpty === false && Array.isArray(value) && !value.length) {
      return value;
    }

    const ttl = ttlOf(kind);
    try {
      await redisClient.set(fullKey, JSON.stringify(value), { EX: ttl });
      if (options.group) {
        const groupKey = GROUP_PREFIX + options.group;
        await redisClient.sAdd(groupKey, fullKey);
        // Set with headroom over the member TTL so the group SET doesn't linger forever.
        await redisClient.expire(groupKey, ttl * 2);
      }
    } catch (err) {
      signale.error(err);
    }
    return value;
  } finally {
    if (holdsLock) {
      await redisClient.del(LOCK_PREFIX + key).catch((err) => {
        signale.error(err);
      });
    }
  }
};

export const invalidate = async (...keys: (string | null | undefined)[]) => {
  if (!isUsable()) return;
  const targets = keys.filter((k): k is string => !!k).map((k) => PREFIX + k);
  if (!targets.length) return;
  try {
    await redisClient.del(targets);
  } catch (err) {
    signale.error(err);
  }
};

export const invalidateGroup = async (group: string) => {
  if (!isUsable()) return;
  const groupKey = GROUP_PREFIX + group;
  try {
    const members = await redisClient.sMembers(groupKey);
    if (members.length) await redisClient.del(members);
    await redisClient.del(groupKey);
  } catch (err) {
    signale.error(err);
  }
};
