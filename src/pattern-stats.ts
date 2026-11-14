import fetch from "node-fetch";
import signale from "signale";

import config from "./config";
import { knex } from "./db";
import { JudgeCounts } from "./judgement";

export interface PatternStats {
  notes: number;
  judges: number;
  requiredJudges: number;
  bullets: number;
  holdTicks: number;
  holdTickWeight: number;
}

const PATTERN_TIMEOUT_MS = 5000;
const END_TRIGGER = 6;
const END_MARGIN_BEATS = 2;
const MIN_RATE = 0.5;
const MAX_RATE = 2;
const SCORE_BASE = 100_000_000;

const holdTickCount = (duration: number) =>
  Math.max(Math.ceil(duration) - 1, 0) + 2;

const toNumber = (value: unknown, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const computePatternStats = (pattern: unknown): PatternStats | null => {
  if (!pattern || typeof pattern !== "object") return null;
  const { patterns, bullets, triggers } = pattern as Record<string, unknown>;
  if (!Array.isArray(patterns) || !patterns.length) return null;

  const end = Array.isArray(triggers)
    ? triggers.find((t) => toNumber(t?.value, -1) === END_TRIGGER)
    : undefined;
  const cutoff = end ? toNumber(end.beat) - END_MARGIN_BEATS : Infinity;

  let judges = 0;
  let requiredJudges = 0;
  let holdTicks = 0;
  let holdTickWeight = 0;
  for (const note of patterns) {
    const beat = toNumber(note?.beat);
    if (toNumber(note?.value) === 2) {
      const duration = Math.max(toNumber(note?.duration), 0);
      const total = holdTickCount(duration);
      judges += 2;
      holdTicks += total - 2;
      holdTickWeight += ((total - 2) * 2) / total;
      if (beat + duration < cutoff) requiredJudges += 2;
      else if (beat < cutoff) requiredJudges += 1;
    } else {
      judges += 1;
      if (beat < cutoff) requiredJudges += 1;
    }
  }

  return {
    notes: patterns.length,
    judges,
    requiredJudges,
    bullets: Array.isArray(bullets) ? bullets.length : 0,
    holdTicks,
    holdTickWeight,
  };
};

const STATS_COLUMNS = [
  "notes",
  "judges",
  "requiredJudges",
  "bullets",
  "holdTicks",
  "holdTickWeight",
] as const;

export const fetchPatternStats = async (
  fileName: string,
  patternIndex: number,
) => {
  const response = await fetch(
    `${config.project.cdn}/URLATE-patterns/${fileName}/${patternIndex}.json`,
    { signal: AbortSignal.timeout(PATTERN_TIMEOUT_MS) },
  );
  if (!response.ok) {
    throw new Error(
      `Pattern ${fileName}/${patternIndex} responded ${response.status}.`,
    );
  }
  return computePatternStats(await response.json());
};

export const readStoredStats = async (
  fileName: string,
  patternIndex: number,
): Promise<PatternStats | null> => {
  const [row] = await knex("patternStats")
    .select(STATS_COLUMNS)
    .where({ fileName, difficulty: patternIndex });
  if (!row) return null;
  return {
    notes: Number(row.notes),
    judges: Number(row.judges),
    requiredJudges: Number(row.requiredJudges),
    bullets: Number(row.bullets),
    holdTicks: Number(row.holdTicks),
    holdTickWeight: Number(row.holdTickWeight),
  };
};

export const storeStats = (
  fileName: string,
  patternIndex: number,
  stats: PatternStats,
) =>
  knex("patternStats")
    .insert({ fileName, difficulty: patternIndex, ...stats })
    .onConflict(["fileName", "difficulty"])
    .merge();

export const getPatternStats = async (
  fileName: string,
  difficultySelection: number,
): Promise<PatternStats | null> => {
  const patternIndex = difficultySelection - 1;
  let stored: PatternStats | null = null;
  let readable = true;
  try {
    stored = await readStoredStats(fileName, patternIndex);
  } catch (err) {
    readable = false;
    signale.error(err);
  }
  if (stored) return stored;

  const stats = await fetchPatternStats(fileName, patternIndex);
  if (stats && readable) {
    await storeStats(fileName, patternIndex, stats).catch((err) =>
      signale.error(err),
    );
  }
  return stats;
};

export const toPlaybackRate = (value: unknown): number | null => {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < MIN_RATE || rate > MAX_RATE) return null;
  return rate;
};

export const rateFactor = (rate: number) =>
  rate >= 1 ? rate * 0.5 + 0.5 : rate * rate * 1.3 - 0.3;

export const maxScoreFor = (
  stats: PatternStats,
  counts: JudgeCounts,
  maxCombo: number,
  rate: number | null,
) => {
  const basic = SCORE_BASE / stats.notes;
  const base =
    basic *
    (stats.holdTickWeight +
      counts.perfect +
      counts.great * 0.8 +
      counts.good * 0.4 +
      counts.bad * 0.1);
  const comboEvents =
    counts.perfect + counts.great + counts.good + stats.holdTicks;
  const ramp = Math.min(comboEvents, maxCombo);
  const comboSum =
    (ramp * (ramp + 1)) / 2 + Math.max(comboEvents - ramp, 0) * maxCombo;
  const scoredEvents = comboEvents + counts.bad;
  return Math.ceil(
    (base + comboSum * 5) * rateFactor(rate ?? MAX_RATE) + scoredEvents,
  );
};

export const checkAgainstPattern = (
  stats: PatternStats,
  counts: JudgeCounts,
  score: number,
  maxCombo: number,
  rate: number | null,
): boolean => {
  const judged =
    counts.perfect + counts.great + counts.good + counts.bad + counts.miss;
  if (judged > stats.judges || judged < stats.requiredJudges) return false;
  if (counts.bullet > stats.bullets) return false;
  const comboLimit = Math.min(
    counts.perfect + counts.great + counts.good + counts.bad + stats.holdTicks,
    stats.judges + stats.holdTicks,
  );
  if (maxCombo > comboLimit) return false;
  return score <= maxScoreFor(stats, counts, maxCombo, rate);
};
