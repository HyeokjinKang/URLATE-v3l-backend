import signale from "signale";

import { isRedisReady, redisClient } from "./redis";

/** Written by the game server (URLATE-v3l-game src/play-session.ts). */
const PLAY_KEY = (playId: string) => `play:${playId}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type PlaySessionStatus =
  | "ok"
  | "missing"
  | "unavailable"
  | "mismatch"
  | "reused"
  | "saved"
  | "unfinished"
  | "interrupted";

export interface PlaySessionCheck {
  status: PlaySessionStatus;
  playId: string | null;
  startedAt?: number;
  endedAt?: number;
  activeMs?: number;
  pausedMs?: number;
  pauses?: number;
}

interface Expected {
  userid: string;
  fileName: string;
  difficultySelection: number;
  rate: number;
}

const toNumber = (value: string | undefined) =>
  value === undefined || value === "" ? undefined : Number(value);

/**
 * Matches a submission against the game server's record of the play and marks
 * the play as submitted. Never throws: Redis trouble becomes "unavailable".
 */
export const checkPlaySession = async (
  playId: unknown,
  expected: Expected,
): Promise<PlaySessionCheck> => {
  if (typeof playId !== "string" || !UUID.test(playId)) {
    return { status: "missing", playId: null };
  }
  if (!isRedisReady()) return { status: "unavailable", playId };

  try {
    const key = PLAY_KEY(playId);
    const play = await redisClient.hGetAll(key);
    if (!play.startedAt) return { status: "missing", playId };

    const startedAt = toNumber(play.startedAt);
    const endedAt = toNumber(play.endedAt);
    const pausedMs = toNumber(play.pausedMs) ?? 0;
    const timing = {
      startedAt,
      endedAt,
      pausedMs,
      pauses: toNumber(play.pauses) ?? 0,
      activeMs:
        startedAt !== undefined && endedAt !== undefined
          ? endedAt - startedAt - pausedMs
          : undefined,
    };

    if (
      play.userid !== expected.userid ||
      play.fileName !== expected.fileName ||
      Number(play.difficultySelection) !== expected.difficultySelection ||
      Number(play.rate) !== expected.rate
    ) {
      return { status: "mismatch", playId, ...timing };
    }

    const first = await redisClient.hSetNX(key, "submittedAt", `${Date.now()}`);
    if (!first) {
      return { status: play.savedAt ? "saved" : "reused", playId, ...timing };
    }

    if (play.interruptedAt || play.abandonedAt) {
      return { status: "interrupted", playId, ...timing };
    }
    if (endedAt === undefined)
      return { status: "unfinished", playId, ...timing };
    return { status: "ok", playId, ...timing };
  } catch (err) {
    signale.error(err);
    return { status: "unavailable", playId };
  }
};

/** Lets the same play be submitted again after the server failed to handle it. */
export const releasePlaySession = async (playId: string | null) => {
  if (!playId || !isRedisReady()) return;
  await redisClient
    .hDel(PLAY_KEY(playId), "submittedAt")
    .catch((err) => signale.error(err));
};

/** Marks the play as stored so a retry of a lost response is answered with success. */
export const markPlaySaved = async (playId: string | null) => {
  if (!playId || !isRedisReady()) return;
  await redisClient
    .hSet(PLAY_KEY(playId), "savedAt", `${Date.now()}`)
    .catch((err) => signale.error(err));
};

/**
 * Adds the expected active time next to the measured one: the song length, or
 * the end trigger when the chart has one before it, divided by the rate.
 */
export const withExpectedMs = (
  session: PlaySessionCheck,
  durationMs: number | null,
  endMs: number | null,
  rate: number,
): PlaySessionCheck & {
  durationMs: number | null;
  endMs: number | null;
  expectedMs?: number;
} => {
  if (durationMs === null) return { ...session, durationMs, endMs };
  const playMs = endMs === null ? durationMs : Math.min(durationMs, endMs);
  return {
    ...session,
    durationMs,
    endMs,
    expectedMs: Math.round(Math.max(playMs, 0) / rate),
  };
};

const LATE_SLACK_MS = 3000;
const LATE_SLACK_RATIO = 0.02;
const EARLY_SLACK_MS = 1500;

/** True when the server-measured active time fits the song length at the submitted rate. */
export const isPlayTimeValid = (activeMs: number, expectedMs: number) =>
  activeMs >= expectedMs - EARLY_SLACK_MS &&
  activeMs <= expectedMs * (1 + LATE_SLACK_RATIO) + LATE_SLACK_MS;
