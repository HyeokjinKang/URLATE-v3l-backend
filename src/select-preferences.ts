import signale from "signale";

import { safeSegment } from "./cache";
import { isRedisReady, redisClient } from "./redis";
import { isValidFileName } from "./validate";

// Song select state (sort order, difficulty tab, last played track) lives in the
// client's localStorage. A mirror is kept here so a player signing in from
// another browser or device gets the same screen back; localStorage stays the
// first source and this is only read when it has nothing.
export interface SelectPreferences {
  sort?: number;
  difficultySelection?: number;
  songName?: string;
}

const PREFIX = "selectprefs:v1:";

// Refreshed on every write, so an active player never loses the mirror while an
// abandoned key eventually leaves Redis.
const TTL_SEC = 60 * 60 * 24 * 180;

// sortSelected() indexes [name, producer, difficulty, BPM].
const MAX_SORT = 3;
// difficultySelected() indexes the three difficulty tabs.
const MAX_DIFFICULTY_SELECTION = 2;

const toIndex = (value: unknown, max: number): number | undefined => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > max) return undefined;
  return n;
};

// Unknown or out-of-range fields are dropped instead of defaulted: a missing
// field means "the client had nothing", which is different from index 0.
export const normalizeSelectPreferences = (
  input: unknown,
): SelectPreferences => {
  const source =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const preferences: SelectPreferences = {};

  const sort = toIndex(source.sort, MAX_SORT);
  if (sort !== undefined) preferences.sort = sort;

  const difficultySelection = toIndex(
    source.difficultySelection,
    MAX_DIFFICULTY_SELECTION,
  );
  if (difficultySelection !== undefined) {
    preferences.difficultySelection = difficultySelection;
  }

  if (isValidFileName(source.songName)) preferences.songName = source.songName;

  return preferences;
};

const keyOf = (userid: string): string => PREFIX + safeSegment(userid);

export const readSelectPreferences = async (
  userid: string,
): Promise<SelectPreferences> => {
  if (!isRedisReady()) return {};
  try {
    const stored = await redisClient.get(keyOf(userid));
    if (stored === null) return {};
    return normalizeSelectPreferences(JSON.parse(stored));
  } catch (err) {
    signale.error(err);
    return {};
  }
};

export const writeSelectPreferences = async (
  userid: string,
  preferences: SelectPreferences,
): Promise<boolean> => {
  if (!isRedisReady()) return false;
  try {
    // The client sends only the fields it has, so a partial update merges
    // instead of replacing.
    const stored = await redisClient.get(keyOf(userid));
    let current: SelectPreferences = {};
    if (stored !== null) {
      try {
        current = normalizeSelectPreferences(JSON.parse(stored));
      } catch (err) {
        // If the stored value is corrupted, overwrite with the new preferences.
        signale.error(err);
      }
    }
    const merged = { ...current, ...preferences };
    await redisClient.set(keyOf(userid), JSON.stringify(merged), { EX: TTL_SEC });
    return true;
  } catch (err) {
    signale.error(err);
    return false;
  }
};
