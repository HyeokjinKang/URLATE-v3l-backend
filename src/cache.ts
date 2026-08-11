import { createHash } from "crypto";
import signale from "signale";

import config from "./config";
import { isRedisReady, redisClient } from "./redis";

// 스키마가 바뀌면 버전을 올려 기존 캐시를 통째로 무시합니다.
const PREFIX = "cache:v1:";
// 한 번에 비워야 하는 키 목록을 담는 SET의 네임스페이스입니다.
const GROUP_PREFIX = "cachegrp:v1:";

// config에 값이 없을 때 사용하는 기본 TTL(초)입니다.
const DEFAULT_TTL = {
  // 곡이 추가될 때만 바뀝니다.
  tracks: 600,
  trackInfo: 600,
  teamProfile: 600,
  notice: 300,
  // 본인의 쓰기 요청에서 명시적으로 무효화하므로 길게 잡아도 안전합니다.
  user: 300,
  authStatus: 1800,
  profilePic: 300,
  bestRecord: 300,
  // 다른 유저의 플레이로도 바뀌므로 짧게 잡습니다.
  record: 60,
  leaderboard: 60,
  ranking: 60,
  profile: 30,
  // 사실상 불변입니다.
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

// 사용자 입력을 캐시 키 조각으로 정규화합니다. 안전하지 않으면 고정 길이
// 해시로 바꿔 구분자(:) 오염과 키 길이 폭주를 막습니다.
export const safeSegment = (value: string | number): string => {
  const str = String(value);
  return isSafeKeySegment(str)
    ? str
    : "h_" + createHash("sha1").update(str).digest("hex").slice(0, 24);
};

const seg = safeSegment;

// 조회부와 무효화부가 어긋나지 않도록 키를 한곳에서 정의합니다.
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
  // 정렬 조합별로 갈라진 순위표 캐시를 한 번에 비우기 위한 그룹입니다.
  leaderboardGroup: (filename: string, difficulty: string | number) =>
    `board:${seg(filename)}:${seg(difficulty)}`,
};

interface GetOrSetOptions {
  // 지정하면 invalidateGroup으로 한 번에 비울 수 있도록 그룹에 등록합니다.
  group?: string;
  // false면 빈 결과를 저장하지 않습니다. "없는 값" 조회로 캐시가 오염될 수
  // 있는 곳에 씁니다. 미플레이 곡처럼 빈 결과가 정상인 곳에서는 켜 둡니다.
  cacheEmpty?: boolean;
}

const LOCK_PREFIX = "cachelock:v1:";
// 채움이 이보다 오래 걸리면 락이 만료되고 다음 요청이 다시 시도합니다.
const FILL_LOCK_TTL_SEC = 10;
// 다른 요청의 채움을 기다리는 상한입니다. 넘기면 각자 DB로 갑니다.
const FILL_WAIT_TOTAL_MS = 300;
const FILL_WAIT_INTERVAL_MS = 30;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 캐시-어사이드 조회입니다. Redis가 죽어 있거나 오류가 나면 DB로 폴백합니다.
 *
 * 미스가 나면 락을 잡은 요청 하나만 DB를 조회하고 나머지는 잠깐 기다립니다.
 * 뜨거운 키가 만료되는 순간 동시 요청이 전부 DB로 몰리는 것을 막습니다.
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

  // 어떤 경로로 빠져나가든 finally에서 락을 놓습니다.
  let holdsLock = false;
  try {
    try {
      const first = await read();
      if (first.hit) return first.value as T;

      // 채움 담당을 한 명만 정합니다.
      holdsLock =
        (await redisClient.set(LOCK_PREFIX + key, "1", {
          NX: true,
          EX: FILL_LOCK_TTL_SEC,
        })) === "OK";

      if (!holdsLock) {
        // 다른 요청이 채우는 중입니다.
        const deadline = Date.now() + FILL_WAIT_TOTAL_MS;
        while (Date.now() < deadline) {
          await sleep(FILL_WAIT_INTERVAL_MS);
          const retry = await read();
          if (retry.hit) return retry.value as T;
        }
        // 시간 안에 안 채워지면 직접 조회합니다.
      }
    } catch (err) {
      // 여기까지는 Redis 오류뿐이므로 DB로 폴백합니다. fetcher의 오류는
      // 그대로 전파되어야 하므로 이 catch가 감싸지 않도록 범위를 좁혔습니다.
      signale.error(err);
      return await fetcher();
    }

    const value = await fetcher();
    // null/undefined는 캐싱하지 않습니다. "조회 실패"가 TTL 동안 굳습니다.
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
        // 그룹 SET이 영원히 남지 않도록 멤버보다 넉넉한 TTL을 겁니다.
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

// 지정한 캐시 키들을 삭제합니다. 쓰기 경로에서 호출합니다.
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

// 그룹에 등록된 키를 한 번에 삭제합니다. 정렬 조합처럼 여러 갈래로 갈라진
// 캐시를 KEYS/SCAN 없이 비웁니다.
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
