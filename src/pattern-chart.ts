import { createHash } from "node:crypto";
import signale from "signale";

import { fetchPatternText } from "./pattern-stats";
import { createTiming, PatternTiming } from "./pattern-timing";
import { isRedisReady, redisClient } from "./redis";

/** [beat, value, x, y, duration, direction] */
export type ChartNote = [number, number, number, number, number, number];

export interface ReplayChart {
  /** SHA-256 (hex) of the chart file as served by the CDN. */
  hash: string;
  /** Song time in ms where the end trigger finishes the play; null when the song's end does. */
  endMs: number | null;
  endBeat: number | null;
  offset: number;
  /** The parts of the chart that `createTiming` reads. */
  timing: Record<string, unknown>;
  noteData: ChartNote[];
  /** Indexes of hold notes, which count as two misses when missed. */
  holds: number[];
  notes: number;
  bullets: number;
}

const CACHE_TTL_SEC = 24 * 60 * 60;
const END_TRIGGER = 6;
const BPM_TRIGGER = 2;
const HOLD_NOTE = 2;

export const chartCacheKey = (fileName: string, patternIndex: number) =>
  `replayChart:v2:${fileName}:${patternIndex}`;

const toNumber = (value: unknown, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const hashPattern = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export const chartTiming = (chart: ReplayChart): PatternTiming =>
  createTiming(chart.timing);

export const computeReplayChart = (text: string): ReplayChart | null => {
  let pattern: unknown;
  try {
    pattern = JSON.parse(text);
  } catch {
    return null;
  }
  if (!pattern || typeof pattern !== "object") return null;
  const data = pattern as Record<string, unknown>;
  const { patterns, bullets, triggers } = data;
  const information = data.information as Record<string, unknown> | undefined;
  if (!Array.isArray(patterns) || !patterns.length) return null;
  if (!information || typeof information !== "object") return null;
  if (!(toNumber(information.bpm) > 0)) return null;

  const triggerList = Array.isArray(triggers) ? triggers : [];
  const timing = {
    information: { bpm: information.bpm, version: information.version },
    triggers: triggerList.filter((t) => toNumber(t?.value, -1) === BPM_TRIGGER),
  };
  const end = triggerList.find((t) => toNumber(t?.value, -1) === END_TRIGGER);
  const offset = toNumber(information.offset);
  const endBeat = end ? toNumber(end.beat) : null;
  const endMs =
    endBeat === null
      ? null
      : Math.round(createTiming(timing).msAt(endBeat) + offset);

  const holds: number[] = [];
  const noteData: ChartNote[] = patterns.map((note, i) => {
    const value = toNumber(note?.value, -1);
    if (value === HOLD_NOTE) holds.push(i);
    return [
      toNumber(note?.beat),
      value,
      toNumber(note?.x),
      toNumber(note?.y),
      Math.max(toNumber(note?.duration), 0),
      toNumber(note?.direction),
    ];
  });

  return {
    hash: hashPattern(text),
    endMs: endMs !== null && Number.isFinite(endMs) ? endMs : null,
    endBeat,
    offset,
    timing,
    noteData,
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
    chart = computeReplayChart(await fetchPatternText(fileName, patternIndex));
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
