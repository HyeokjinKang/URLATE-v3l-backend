import { createHash } from "crypto";
import signale from "signale";

import config from "./config";
import { isRedisReady, redisClient } from "./redis";

// 캐시 키 네임스페이스입니다. 스키마가 바뀌면 버전을 올려 기존 캐시를 통째로 무시합니다.
const PREFIX = "cache:v1:";
// 묶어서 한 번에 비워야 하는 키들의 목록을 담는 SET의 네임스페이스입니다.
const GROUP_PREFIX = "cachegrp:v1:";

// config에 값이 없을 때 사용하는 기본 TTL(초)입니다.
const DEFAULT_TTL = {
  // 관리자가 곡을 추가할 때만 바뀌는 준정적 데이터입니다.
  tracks: 600,
  trackInfo: 600,
  teamProfile: 600,
  notice: 300,
  // 유저 본인의 쓰기 요청에서 명시적으로 무효화하므로 길게 잡아도 안전합니다.
  user: 300,
  authStatus: 1800,
  profilePic: 300,
  bestRecord: 300,
  // 다른 유저의 플레이로도 바뀌므로 짧게 유지합니다.
  record: 60,
  leaderboard: 60,
  ranking: 60,
  profile: 30,
  // 사실상 불변인 마스터 데이터입니다.
  achievements: 3600,
};

export type CacheKind = keyof typeof DEFAULT_TTL;

const cacheConfig = config.cache ?? {};
const cacheEnabled = cacheConfig.enabled ?? true;

// 설정값이 있으면 우선하고, 없거나 잘못된 값이면 기본값으로 되돌립니다.
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

// 캐시 키에 그대로 넣어도 안전한 값인지 확인합니다.
const isSafeKeySegment = (value: string): boolean =>
  /^[A-Za-z0-9_.-]{1,128}$/.test(value);

/**
 * 사용자 입력을 캐시 키 조각으로 정규화합니다.
 * 그대로 써도 안전하면 그대로 두고, 아니면 길이가 고정된 해시로 바꿉니다.
 * 구분자(:) 오염과 키 길이 폭주를 원천 차단하기 위해 모든 키 조합에 적용합니다.
 */
export const safeSegment = (value: string | number): string => {
  const str = String(value);
  return isSafeKeySegment(str)
    ? str
    : "h_" + createHash("sha1").update(str).digest("hex").slice(0, 24);
};

const seg = safeSegment;

// 캐시 키를 한곳에서 정의해 조회부와 무효화부가 어긋나지 않게 합니다.
export const keys = {
  tracksAll: () => "tracks:all",
  track: (name: string) => `track:${seg(name)}`,
  trackInfo: (filename: string) => `trackinfo:${seg(filename)}`,
  notice: (lang: string) => `notice:${seg(lang)}`,
  teamProfile: (name: string) => `team:${seg(name)}`,
  profilePic: (nickname: string) => `pic:${seg(nickname)}`,
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
  // 지정하면 해당 그룹에 키를 등록해 invalidateGroup으로 한 번에 비울 수 있습니다.
  group?: string;
  // false면 빈 결과를 저장하지 않습니다. 키가 사실상 자유 입력이라
  // "없는 값" 조회로 캐시가 오염될 수 있는 엔드포인트에 사용합니다.
  // 반대로 미플레이 곡처럼 빈 결과가 정상이고 자주 조회되는 경우에는 켜 둡니다.
  cacheEmpty?: boolean;
}

/**
 * 캐시-어사이드 조회입니다. Redis가 죽어 있거나 오류가 나면 조용히 DB로 폴백합니다.
 * 캐시 때문에 요청이 실패하는 일은 없어야 합니다.
 */
export const getOrSet = async <T>(
  kind: CacheKind,
  key: string,
  fetcher: () => Promise<T>,
  options: GetOrSetOptions = {},
): Promise<T> => {
  if (!isUsable()) return fetcher();

  const fullKey = PREFIX + key;
  try {
    const cached = await redisClient.get(fullKey);
    if (cached !== null) return JSON.parse(cached) as T;
  } catch (err) {
    signale.error(err);
    return fetcher();
  }

  const value = await fetcher();
  // null/undefined는 캐싱하지 않습니다. "조회 실패"가 TTL 동안 굳는 것을 방지합니다.
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
      // 그룹 SET이 영원히 남지 않도록 멤버보다 넉넉한 TTL을 걸어둡니다.
      await redisClient.expire(groupKey, ttl * 2);
    }
  } catch (err) {
    // 저장 실패는 응답에 영향을 주지 않습니다.
    signale.error(err);
  }
  return value;
};

/**
 * 지정한 캐시 키들을 삭제합니다. 쓰기 경로에서 호출합니다.
 */
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

/**
 * 그룹에 등록된 모든 캐시 키를 한 번에 삭제합니다.
 * 정렬 조건 조합처럼 키가 여러 갈래로 갈라지는 캐시를 KEYS/SCAN 없이 비웁니다.
 */
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
