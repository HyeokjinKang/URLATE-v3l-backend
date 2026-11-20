import { JudgeCounts } from "./judgement";
import { ReplayChart } from "./pattern-chart";

/** Event row written by URLATE public/js/player.js logEvent: [seekMs, wallMs, kind, index, mouseX, mouseY, judge, key]. */
interface ReplayEvent {
  seekMs: number;
  wallMs: number;
  kind: string;
  index: number;
  judge: string;
}

export interface ReplayCheckInput {
  record: unknown;
  counts: JudgeCounts;
  chart: ReplayChart;
  rate: number;
  durationMs: number;
  session: {
    startedAt?: number;
    endedAt?: number;
    pausedMs?: number;
    pauses?: number;
  };
}

export type ReplayCheckFailure =
  | "version"
  | "events"
  | "index"
  | "counts"
  | "seek"
  | "speed"
  | "pauses"
  | "pause-count"
  | "pause-time"
  | "pause-seek"
  | "wall";

export const MAX_PAUSES = 10;

const REPLAY_VERSION = 2;
const MAX_EVENTS = 200_000;
const SEEK_SLACK_MS = 1000;
const SPEED_MIN_SPAN_MS = 10_000;
const SPEED_SLACK_RATIO = 0.02;
const SPEED_SLACK_MS = 500;
const SEEK_REWIND_MS = 50;
const PAUSE_SEEK_SLACK_MS = 250;
const PAUSE_TIME_SLACK_MS = 1000;
const PAUSE_TIME_SLACK_PER_PAUSE_MS = 200;
const WALL_SLACK_MS = 2000;

const JUDGE_KEYS: Record<string, keyof JudgeCounts> = {
  Perfect: "perfect",
  Great: "great",
  Good: "good",
  Bad: "bad",
};

const parseEvents = (record: unknown): ReplayEvent[] | ReplayCheckFailure => {
  if (!record || typeof record !== "object" || Array.isArray(record))
    return "version";
  const { v, events } = record as { v?: unknown; events?: unknown };
  if (v !== REPLAY_VERSION) return "version";
  if (!Array.isArray(events) || events.length > MAX_EVENTS) return "events";
  const parsed: ReplayEvent[] = [];
  for (const row of events) {
    if (!Array.isArray(row) || row.length < 7) return "events";
    const [seekMs, wallMs, kind, index, , , judge] = row;
    if (
      typeof seekMs !== "number" ||
      !Number.isFinite(seekMs) ||
      typeof wallMs !== "number" ||
      !Number.isFinite(wallMs) ||
      typeof kind !== "string" ||
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      typeof judge !== "string"
    ) {
      return "events";
    }
    parsed.push({ seekMs, wallMs, kind, index, judge });
  }
  return parsed;
};

/** Judge counts as the client tallies them (player.js countJudge, the miss sweep and bullet hits). */
export const countReplayJudges = (
  events: ReplayEvent[],
  chart: ReplayChart,
): JudgeCounts | "index" => {
  const holds = new Set(chart.holds);
  const counts: JudgeCounts = {
    perfect: 0,
    great: 0,
    good: 0,
    bad: 0,
    miss: 0,
    bullet: 0,
  };
  for (const event of events) {
    switch (event.kind) {
      case "press":
      case "release":
        if (event.index < 0 || event.index >= chart.notes) return "index";
        counts[JUDGE_KEYS[event.judge] ?? "miss"]++;
        break;
      case "miss":
        if (event.index < 0 || event.index >= chart.notes) return "index";
        counts.miss += holds.has(event.index) ? 2 : 1;
        break;
      case "bullet":
        if (event.index < 0 || event.index >= chart.bullets) return "index";
        counts.bullet++;
        break;
    }
  }
  return counts;
};

const sameCounts = (a: JudgeCounts, b: JudgeCounts) =>
  a.perfect === b.perfect &&
  a.great === b.great &&
  a.good === b.good &&
  a.bad === b.bad &&
  a.miss === b.miss &&
  a.bullet === b.bullet;

/** Splits the play into stretches where the song was running, dropping events logged while paused. */
const playingStretches = (events: ReplayEvent[]) => {
  const stretches: ReplayEvent[][] = [];
  let current: ReplayEvent[] = [];
  let paused = false;
  for (const event of events) {
    if (event.kind === "pause") {
      if (!paused) {
        current.push(event);
        stretches.push(current);
        current = [];
      }
      paused = true;
    } else if (event.kind === "resume") {
      paused = false;
      current = [event];
    } else if (!paused) {
      current.push(event);
    }
  }
  if (!paused) stretches.push(current);
  return stretches;
};

/** True when the song advanced at the submitted rate against the client's wall clock. */
const speedMatches = (stretch: ReplayEvent[], rate: number) => {
  const monotonic: ReplayEvent[] = [];
  let maxSeek = -Infinity;
  for (const event of stretch) {
    if (event.seekMs < maxSeek - SEEK_REWIND_MS) continue;
    monotonic.push(event);
    maxSeek = Math.max(maxSeek, event.seekMs);
  }
  if (monotonic.length < 2) return true;
  const first = monotonic[0];
  const last = monotonic[monotonic.length - 1];
  const wall = last.wallMs - first.wallMs;
  if (wall < SPEED_MIN_SPAN_MS) return true;
  const seek = last.seekMs - first.seekMs;
  return (
    Math.abs(seek - rate * wall) <=
    SPEED_SLACK_RATIO * rate * wall + SPEED_SLACK_MS
  );
};

const checkPauses = (
  events: ReplayEvent[],
  session: ReplayCheckInput["session"],
): ReplayCheckFailure | null => {
  let count = 0;
  let pausedMs = 0;
  let pausedAt: ReplayEvent | null = null;
  for (const event of events) {
    if (event.kind === "pause" && !pausedAt) {
      count++;
      pausedAt = event;
    } else if (event.kind === "resume" && pausedAt) {
      if (Math.abs(event.seekMs - pausedAt.seekMs) > PAUSE_SEEK_SLACK_MS)
        return "pause-seek";
      pausedMs += event.wallMs - pausedAt.wallMs;
      pausedAt = null;
    }
  }
  if (count > MAX_PAUSES) return "pauses";
  const serverPauses = session.pauses ?? 0;
  if (count < serverPauses || count > serverPauses + 1) return "pause-count";
  const slack =
    PAUSE_TIME_SLACK_MS + PAUSE_TIME_SLACK_PER_PAUSE_MS * Math.max(count, 1);
  if (Math.abs(pausedMs - (session.pausedMs ?? 0)) > slack) return "pause-time";
  return null;
};

/**
 * Checks the submitted replay against the submitted judge counts, the chart
 * and the game server's play session. Returns the first failure, or null.
 */
export const checkReplay = ({
  record,
  counts,
  chart,
  rate,
  durationMs,
  session,
}: ReplayCheckInput): ReplayCheckFailure | null => {
  const events = parseEvents(record);
  if (typeof events === "string") return events;

  const tallied = countReplayJudges(events, chart);
  if (tallied === "index") return "index";
  if (!sameCounts(tallied, counts)) return "counts";

  if (events.some((e) => e.seekMs > durationMs + SEEK_SLACK_MS)) return "seek";

  const pauses = checkPauses(events, session);
  if (pauses) return pauses;

  if (!playingStretches(events).every((s) => speedMatches(s, rate)))
    return "speed";

  if (session.startedAt !== undefined && session.endedAt !== undefined) {
    const serverMs = session.endedAt - session.startedAt;
    if (events.some((e) => e.wallMs > serverMs + WALL_SLACK_MS)) return "wall";
  }
  return null;
};
