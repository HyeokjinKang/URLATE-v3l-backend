import fs from "fs-extra";
import path from "path";
import signale from "signale";

import config from "./config";

const DEFAULT_RETENTION_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const MAX_RECORD_CHARS = 64 * 1024;

export const logsRoot = path.resolve(__dirname, "../logs");

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

// Returns false if the resolved path escapes the log root. The caller already
// format-validates nickname and fileName; this is a second layer.
export const writeReplayLog = (
  nickname: string,
  fileName: string,
  record: unknown,
): boolean => {
  if (retentionDays() === 0) return true;
  if (record === undefined || record === null) return true;

  const serialized = JSON.stringify(record);
  if (serialized === undefined || serialized.length > MAX_RECORD_CHARS) {
    signale.warn(
      `Skipped an oversized or unserializable replay from ${nickname}.`,
    );
    return true;
  }

  const logDir = path.resolve(logsRoot, nickname, fileName);
  if (logDir !== logsRoot && !logDir.startsWith(logsRoot + path.sep)) {
    return false;
  }
  const logFile = path.join(logDir, `${Date.now()}.json`);
  fs.outputFile(logFile, serialized).catch((err) => signale.error(err));
  return true;
};

export const cleanupReplayLogs = async () => {
  const days = retentionDays();
  const cutoff = Date.now() - days * MS_PER_DAY;
  let removed = 0;

  const walk = async (dir: string): Promise<number> => {
    let remaining = 0;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") signale.error(err);
      return 0;
    }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          const left = await walk(target);
          if (left === 0) await fs.rmdir(target).catch(() => {});
          else remaining += left;
          continue;
        }
        const stat = await fs.stat(target);
        if (stat.mtimeMs < cutoff) {
          await fs.unlink(target);
          removed++;
        } else {
          remaining++;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT")
          signale.error(err);
      }
    }
    return remaining;
  };

  try {
    await walk(logsRoot);
    if (removed) {
      signale.success(
        `Removed ${removed} replay log(s) older than ${days} day(s).`,
      );
    }
  } catch (err) {
    signale.error(err);
  }
};
