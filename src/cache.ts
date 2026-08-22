import { createHash } from "crypto";
import signale from "signale";

import config from "./config";
import { isRedisReady, redisClient } from "./redis";

// Bump this to invalidate every existing cache entry when the schema changes.
const PREFIX = "cache:v1:";
// Namespace for the SETs that track keys to be cleared together.
const GROUP_PREFIX = "cachegrp:v1:";

// Default TTL (seconds) used when config has no value for a kind.
const DEFAULT_TTL = {
  // Only changes when a track is added.
  tracks: 600,
  trackInfo: 600,
  teamProfile: 600,
  notice: 300,
  // Safe to keep long since the owner's own write explicitly invalidates it.
  user: 300,
  authStatus: 1800,
  profilePic: 300,
  bestRecord: 300,
  // Short-lived since other users' plays can change it too.
  record: 60,
  leaderboard: 60,
  ranking: 60,
  profile: 30,
  // Effectively immutable.
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

// Normalizes user input into a cache-key segment. Unsafe input is replaced with
// a fixed-length hash to prevent delimiter (:) injection and unbounded key length.
export const safeSegment = (value: string | number): string => {
  const str = String(value);
  return isSafeKeySegment(str)
    ? str
    : "h_" + createHash("sha1").update(str).digest("hex").slice(0, 24);
};

const seg = safeSegment;

// Defined in one place so lookups and invalidations never drift apart.
export const keys = {
  tracksAll: () => "tracks:all",
  track: (name: string) => `track:${seg(name)}`,
  trackInfo: (filename: string) => `trackinfo:${seg(filename)}`,
  notice: (lang: string) => `notice:${seg(lang)}`,
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
  // Group used to clear every sort-order variant of a leaderboard cache at once.
  leaderboardGroup: (filename: string, difficulty: string | number) =>
    `board:${seg(filename)}:${seg(difficulty)}`,
};

interface GetOrSetOptions {
  // If set, registers the key in a group that invalidateGroup can clear at once.
  group?: string;
  // When false, an empty result isn't cached. Use this where a "not found" lookup
  // could poison the cache; leave it on where an empty result is normal, like an
  // unplayed track.
  cacheEmpty?: boolean;
}

const LOCK_PREFIX = "cachelock:v1:";
// If filling takes longer than this, the lock expires and the next request retries.
const FILL_LOCK_TTL_SEC = 10;
// Cap on how long to wait for another request's fill before going to the DB directly.
const FILL_WAIT_TOTAL_MS = 300;
const FILL_WAIT_INTERVAL_MS = 30;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cache-aside lookup. Falls back to the DB if Redis is down or errors.
 *
 * On a miss, only the request that holds the lock queries the DB; the rest wait
 * briefly. This prevents a thundering herd when a hot key expires.
 */
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

  // Released in finally regardless of which path exits.
  let holdsLock = false;
  try {
    try {
      const first = await read();
      if (first.hit) return first.value as T;

      // Elect exactly one request to fill the value.
      holdsLock =
        (await redisClient.set(LOCK_PREFIX + key, "1", {
          NX: true,
          EX: FILL_LOCK_TTL_SEC,
        })) === "OK";

      if (!holdsLock) {
        // Another request is already filling it.
        const deadline = Date.now() + FILL_WAIT_TOTAL_MS;
        while (Date.now() < deadline) {
          await sleep(FILL_WAIT_INTERVAL_MS);
          const retry = await read();
          if (retry.hit) return retry.value as T;
        }
        // Not filled in time; query it directly.
      }
    } catch (err) {
      // Only Redis errors reach here -- kept narrow so a fetcher error still
      // propagates instead of being swallowed by this catch.
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

// Deletes the given cache keys. Called from write paths.
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

// Deletes every key registered in a group at once, clearing a cache that's split
// into many variants (e.g. by sort order) without a KEYS/SCAN.
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
