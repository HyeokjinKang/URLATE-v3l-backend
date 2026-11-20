import signale from "signale";

import { fetchPattern } from "./pattern-stats";
import { createMsAt } from "./pattern-timing";
import { isRedisReady, redisClient } from "./redis";

export interface ReplayChart {
  /** Song time in ms where the end trigger finishes the play; null when the song's end does. */
  endMs: number | null;
  /** Indexes of hold notes, which count as two misses when missed. */
  holds: number[];
  notes: number;
  bullets: number;
}

const CACHE_TTL_SEC = 24 * 60 * 60;
const END_TRIGGER = 6;
const HOLD_NOTE = 2;

export const chartCacheKey = (fileName: string, patternIndex: number) =>
  `replayChart:${fileName}:${patternIndex}`;

const toNumber = (value: unknown, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const computeReplayChart = (pattern: unknown): ReplayChart | null => {
  if (!pattern || typeof pattern !== "object") return null;
  const data = pattern as Record<string, unknown>;
  const { patterns, bullets, triggers, information } = data;
  if (!Array.isArray(patterns) || !patterns.length) return null;
  if (!information || typeof information !== "object") return null;
  if (!(toNumber((information as Record<string, unknown>).bpm) > 0))
    return null;

  const end = Array.isArray(triggers)
    ? triggers.find((t) => toNumber(t?.value, -1) === END_TRIGGER)
    : undefined;
  const offset = toNumber((information as Record<string, unknown>).offset);
  const endMs = end
    ? Math.round(createMsAt(data)(toNumber(end.beat)) + offset)
    : null;

  const holds: number[] = [];
  patterns.forEach((note, i) => {
    if (toNumber(note?.value, -1) === HOLD_NOTE) holds.push(i);
  });

  return {
    endMs: endMs !== null && Number.isFinite(endMs) ? endMs : null,
    holds,
    notes: patterns.length,
    bullets: Array.isArray(bullets) ? bullets.length : 0,
  };
};

/** The parts of a chart the replay check needs, cached in Redis. null when the chart can't be read. */
export const getReplayChart = async (
  fileName: string,
  difficultySelection: number,
): Promise<ReplayChart | null> => {
  const patternIndex = difficultySelection - 1;
  const key = chartCacheKey(fileName, patternIndex);
  if (isRedisReady()) {
    try {
      const cached = await redisClient.get(key);
      if (cached) return JSON.parse(cached) as ReplayChart;
    } catch (err) {
      signale.error(err);
    }
  }
  let chart: ReplayChart | null;
  try {
    chart = computeReplayChart(await fetchPattern(fileName, patternIndex));
  } catch (err) {
    signale.error(err);
    return null;
  }
  if (chart && isRedisReady()) {
    await redisClient
      .set(key, JSON.stringify(chart), { EX: CACHE_TTL_SEC })
      .catch((err) => signale.error(err));
  }
  return chart;
};
