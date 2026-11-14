import signale from "signale";

import { safeSegment } from "./cache";
import { isRedisReady, redisClient } from "./redis";
import { isValidFileName } from "./validate";

export interface SelectPreferences {
  sort?: number;
  difficultySelection?: number;
  songName?: string;
  rate?: number;
  disableText?: boolean;
  autoPlay?: boolean;
}

const PREFIX = "selectprefs:v1:";

const TTL_SEC = 60 * 60 * 24 * 180;

// sortSelected() indexes [name, producer, difficulty, BPM].
const MAX_SORT = 3;
// difficultySelected() indexes the three difficulty tabs.
const MAX_DIFFICULTY_SELECTION = 2;
// rateChanged() clamps the playback rate to 0.5-2 in 0.1 steps.
const MIN_RATE = 0.5;
const MAX_RATE = 2;

const toIndex = (value: unknown, max: number): number | undefined => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > max) return undefined;
  return n;
};

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

  const rate = source.rate;
  if (typeof rate === "number" && rate >= MIN_RATE && rate <= MAX_RATE) {
    preferences.rate = Math.round(rate * 10) / 10;
  }

  if (typeof source.disableText === "boolean") {
    preferences.disableText = source.disableText;
  }
  if (typeof source.autoPlay === "boolean") {
    preferences.autoPlay = source.autoPlay;
  }

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
    const stored = await redisClient.get(keyOf(userid));
    let current: SelectPreferences = {};
    if (stored !== null) {
      try {
        current = normalizeSelectPreferences(JSON.parse(stored));
      } catch (err) {
        signale.error(err);
      }
    }
    const merged = { ...current, ...preferences };
    await redisClient.set(keyOf(userid), JSON.stringify(merged), {
      EX: TTL_SEC,
    });
    return true;
  } catch (err) {
    signale.error(err);
    return false;
  }
};
