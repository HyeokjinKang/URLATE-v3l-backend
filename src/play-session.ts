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
    if (!first) return { status: "reused", playId, ...timing };

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

/** Adds the expected active time (song length ÷ rate) next to the measured one. */
export const withExpectedMs = (
  session: PlaySessionCheck,
  durationMs: number | null,
  rate: number,
): PlaySessionCheck & { durationMs: number | null; expectedMs?: number } =>
  durationMs === null
    ? { ...session, durationMs }
    : { ...session, durationMs, expectedMs: Math.round(durationMs / rate) };

const LATE_SLACK_MS = 3000;
const LATE_SLACK_RATIO = 0.02;
const EARLY_SLACK_MS = 1500;

/** True when the server-measured active time fits the song length at the submitted rate. */
export const isPlayTimeValid = (activeMs: number, expectedMs: number) =>
  activeMs >= expectedMs - EARLY_SLACK_MS &&
  activeMs <= expectedMs * (1 + LATE_SLACK_RATIO) + LATE_SLACK_MS;
