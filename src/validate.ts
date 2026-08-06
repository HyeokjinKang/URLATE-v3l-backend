// 라우트와 기록 저장 계층이 공유하는 입력 검증 헬퍼입니다.

/**
 * DB의 JSON 문자열 컬럼을 파싱합니다. 실패 시 null을 돌려주므로 호출부가
 * 기본값으로 진행할 수 있습니다. 맨 JSON.parse는 값 하나가 손상되면 라우트를
 * 통째로 500으로 떨어뜨립니다.
 */
export const parseJson = <T = unknown>(value: unknown): T | null => {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

export const isValidNickname = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{5,12}$/.test(value);

export const isValidFileName = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9]{1,255}$/.test(value);

// 유한한 비음수 정수만 허용합니다(이상치·치팅 방지).
export const toFiniteNonNegInt = (value: unknown): number | null => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
};

// 점수 이론적 상한입니다. 실제 최고 기록보다 충분히 큽니다.
export const MAX_SCORE = 200_000_000;

export const RANKS = new Set(["SS", "S", "A", "B", "C", "F"]);

export const SORT_DIRECTIONS = new Set(["asc", "desc"]);

// orderBy에 그대로 들어가므로 화이트리스트가 필요합니다(식별자 주입 방지).
export const TRACK_ORDER_COLUMNS = new Set([
  "rank",
  "record",
  "maxcombo",
  "accuracy",
  "rating",
]);

// 컬럼명 조합(title_ko 등)에 쓰이므로 화이트리스트가 필요합니다.
export const NOTICE_LANGS = new Set(["ko", "en"]);

// trackRecords.index는 uuid v4 조각을 재배열한 32자리 16진 문자열입니다.
export const isValidRecordIndex = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{32}$/.test(value);

// difficultySelection은 1부터 시작합니다.
export const MAX_DIFFICULTY_SELECTION = 20;

export const toDifficultySelection = (value: unknown): number | null => {
  const n = toFiniteNonNegInt(value);
  if (n === null || n < 1 || n > MAX_DIFFICULTY_SELECTION) return null;
  return n;
};
