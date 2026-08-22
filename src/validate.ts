// Input validation helpers shared by the routes and the record persistence layer.

/**
 * Parses a DB column holding a JSON string. Returns null on failure so
 * callers can fall back to a default. A bare JSON.parse would take down the
 * whole route with a 500 over one corrupted value.
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

// Only finite, non-negative integers are allowed (rejects outliers/cheating).
export const toFiniteNonNegInt = (value: unknown): number | null => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
};

// Theoretical score ceiling, comfortably above any real high score.
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

// trackRecords.index is a 32-char hex string made of reordered uuid v4 segments.
export const isValidRecordIndex = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{32}$/.test(value);

// difficultySelection is 1-indexed.
export const MAX_DIFFICULTY_SELECTION = 20;

export const toDifficultySelection = (value: unknown): number | null => {
  const n = toFiniteNonNegInt(value);
  if (n === null || n < 1 || n > MAX_DIFFICULTY_SELECTION) return null;
  return n;
};
