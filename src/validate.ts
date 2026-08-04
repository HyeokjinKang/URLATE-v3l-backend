// 여러 라우트와 기록 저장 계층이 공유하는 입력 검증 헬퍼입니다.
// 검증 규칙이 한 곳에만 있어야 우회 경로가 생기지 않습니다.

export const isValidNickname = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{5,12}$/.test(value);

export const isValidFileName = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9]{1,255}$/.test(value);

// 유한한 비음수 정수만 허용합니다(치팅용 이상치 방지).
export const toFiniteNonNegInt = (value: unknown): number | null => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
};

// 판정 점수 이론적 상한(정합성 검증용). 실제 최고 기록보다 충분히 큰 값입니다.
export const MAX_SCORE = 200_000_000;

// 서버가 산출하는 랭크 등급입니다.
export const RANKS = new Set(["SS", "S", "A", "B", "C", "F"]);

// 정렬 방향 화이트리스트입니다.
export const SORT_DIRECTIONS = new Set(["asc", "desc"]);

// trackRecords 정렬 가능 컬럼 화이트리스트입니다.
export const TRACK_ORDER_COLUMNS = new Set([
  "rank",
  "record",
  "maxcombo",
  "accuracy",
  "rating",
]);

// 다국어 공지 언어 화이트리스트입니다.
export const NOTICE_LANGS = new Set(["ko", "en"]);

// trackRecords.index는 uuid v4의 조각을 재배열한 32자리 16진 문자열입니다.
export const isValidRecordIndex = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{32}$/.test(value);

// 곡당 난이도 수의 상한입니다. difficultySelection은 1부터 시작합니다.
export const MAX_DIFFICULTY_SELECTION = 20;

export const toDifficultySelection = (value: unknown): number | null => {
  const n = toFiniteNonNegInt(value);
  if (n === null || n < 1 || n > MAX_DIFFICULTY_SELECTION) return null;
  return n;
};
