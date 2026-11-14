import fs from "fs-extra";
import path from "path";
import signale from "signale";

import config from "./config";
import { isRedisReady, redisClient } from "./redis";

const DEFAULT_RETENTION_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

const PRUNE_TARGET_RATIO = 0.9;

const TOTAL_BYTES_KEY = "replaylog:bytes:total";

export const logsRoot = path.resolve(__dirname, "../logs");

export const unverifiedLogsRoot = path.resolve(__dirname, "../logs-unverified");

const logRoots = [logsRoot, unverifiedLogsRoot];

export const retentionDays = (): number => {
  const configured = config.project.replayLogRetentionDays;
  if (
    typeof configured === "number" &&
    Number.isFinite(configured) &&
    configured >= 0
  ) {
    return Math.floor(configured);
  }
  return DEFAULT_RETENTION_DAYS;
};

export const maxTotalBytes = (): number => {
  const configured = config.project.replayLogMaxBytes;
  if (
    typeof configured === "number" &&
    Number.isFinite(configured) &&
    configured >= 0
  ) {
    return Math.floor(configured);
  }
  return DEFAULT_MAX_TOTAL_BYTES;
};

type LogFile = { file: string; time: number; size: number };

const listLogFiles = async (dir: string, out: LogFile[] = []) => {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") signale.error(err);
    return out;
  }
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        await listLogFiles(target, out);
        continue;
      }
      const stat = await fs.stat(target);
      out.push({ file: target, time: stat.mtimeMs, size: stat.size });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") signale.error(err);
    }
  }
  return out;
};

const removeEmptyDirs = async (dir: string): Promise<boolean> => {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  let empty = true;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      empty = false;
      continue;
    }
    const target = path.join(dir, entry.name);
    if (await removeEmptyDirs(target)) await fs.rmdir(target).catch(() => {});
    else empty = false;
  }
  return empty;
};

const removeLog = async (log: LogFile) => {
  try {
    await fs.unlink(log.file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") signale.error(err);
    return false;
  }
};

const setTotal = async (bytes: number) => {
  if (!isRedisReady()) return;
  try {
    await redisClient.set(TOTAL_BYTES_KEY, bytes);
  } catch (err) {
    signale.error(err);
  }
};

const listAllLogFiles = async () => {
  const out: LogFile[] = [];
  for (const root of logRoots) await listLogFiles(root, out);
  return out;
};

const removeAllEmptyDirs = async () => {
  for (const root of logRoots) await removeEmptyDirs(root);
};

const pruneOldest = async (budget: number) => {
  const logs = await listAllLogFiles();
  let total = logs.reduce((sum, log) => sum + log.size, 0);
  let removed = 0;
  if (total > budget) {
    logs.sort((a, b) => a.time - b.time);
    for (const log of logs) {
      if (total <= budget) break;
      if (await removeLog(log)) {
        total -= log.size;
        removed++;
      }
    }
    await removeAllEmptyDirs();
  }
  await setTotal(total);
  if (removed) {
    signale.warn(
      `Removed ${removed} oldest replay log(s) to stay under ${maxTotalBytes()} bytes.`,
    );
  }
  return total;
};

let pruning: Promise<number> | null = null;

const pruneOnce = (budget: number) => {
  pruning ??= pruneOldest(budget).finally(() => {
    pruning = null;
  });
  return pruning;
};

const makeRoom = (bytes: number) =>
  pruneOnce(Math.floor(maxTotalBytes() * PRUNE_TARGET_RATIO) - bytes);

const reserveBytes = async (bytes: number) => {
  if (!isRedisReady()) return;
  try {
    const total = await redisClient.incrBy(TOTAL_BYTES_KEY, bytes);
    if (total > maxTotalBytes()) {
      await makeRoom(bytes);
      await redisClient.incrBy(TOTAL_BYTES_KEY, bytes);
    } else if (total === bytes) {
      await pruneOnce(maxTotalBytes() - bytes);
      await redisClient.incrBy(TOTAL_BYTES_KEY, bytes);
    }
  } catch (err) {
    signale.error(err);
  }
};

// A path segment can only be these characters, so it can never introduce a
// separator or a "..". Checked here rather than trusting the caller.
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,255}$/;

// Returns false if either segment is unusable or the resolved path escapes the
// log root.
export const writeReplayLog = async (
  nickname: string,
  fileName: string,
  record: unknown,
  verified = true,
): Promise<boolean> => {
  if (retentionDays() === 0) return true;
  if (record === undefined || record === null) return true;

  if (!SAFE_SEGMENT.test(nickname) || !SAFE_SEGMENT.test(fileName)) {
    return false;
  }
  const root = verified ? logsRoot : unverifiedLogsRoot;
  const logDir = path.resolve(root, nickname, fileName);
  if (!logDir.startsWith(root + path.sep)) {
    return false;
  }

  const serialized = JSON.stringify(record);
  if (serialized === undefined) return true;
  const bytes = Buffer.byteLength(serialized);
  await reserveBytes(bytes);

  const logFile = path.join(logDir, `${Date.now()}.json`);
  try {
    await fs.outputFile(logFile, serialized);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOSPC") {
      signale.error(err);
      return true;
    }
    await makeRoom(bytes);
    await fs.outputFile(logFile, serialized).catch((retryErr) => {
      signale.error(retryErr);
    });
  }
  return true;
};

export const cleanupReplayLogs = async () => {
  const days = retentionDays();
  const cutoff = Date.now() - days * MS_PER_DAY;
  try {
    const logs = await listAllLogFiles();
    let removed = 0;
    for (const log of logs) {
      if (log.time < cutoff && (await removeLog(log))) removed++;
    }
    await removeAllEmptyDirs();
    await pruneOldest(maxTotalBytes());
    if (removed) {
      signale.success(
        `Removed ${removed} replay log(s) older than ${days} day(s).`,
      );
    }
  } catch (err) {
    signale.error(err);
  }
};

export const ensureReplayLogTotal = async () => {
  if (!isRedisReady() || (await redisClient.exists(TOTAL_BYTES_KEY))) return;
  await cleanupReplayLogs();
};
