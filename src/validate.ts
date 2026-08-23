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

export const toFiniteNonNegInt = (value: unknown): number | null => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
};

export const MAX_SCORE = 200_000_000;

export const RANKS = new Set(["SS", "S", "A", "B", "C", "F"]);

export const SORT_DIRECTIONS = new Set(["asc", "desc"]);

// Fed directly into orderBy, so a whitelist is required to prevent identifier injection.
export const TRACK_ORDER_COLUMNS = new Set([
  "rank",
  "record",
  "maxcombo",
  "accuracy",
  "rating",
]);

// Used to build column names (e.g. title_ko), so a whitelist is required.
export const NOTICE_LANGS = new Set(["ko", "en"]);

export const isValidRecordIndex = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{32}$/.test(value);

export const MAX_DIFFICULTY_SELECTION = 20;

export const toDifficultySelection = (value: unknown): number | null => {
  const n = toFiniteNonNegInt(value);
  if (n === null || n < 1 || n > MAX_DIFFICULTY_SELECTION) return null;
  return n;
};
