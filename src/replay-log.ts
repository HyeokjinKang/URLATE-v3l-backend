import fs from "fs/promises";
import path from "path";
import signale from "signale";

import config from "./config";
import {
  BunnyZone,
  deleteObject,
  listObjects,
  putObject,
} from "./services/bunny-storage";

const DEFAULT_RETENTION_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const PRUNE_TARGET_RATIO = 0.9;

const FLUSH_INTERVAL_MS = 5 * 60 * 1000;

const KINDS = ["verified", "unverified"] as const;

const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,255}$/;

const DAY_NAME = /^\d{4}-\d{2}-\d{2}$/;

const LOG_NAME =
  /^[A-Za-z0-9_-]{1,255}\.[A-Za-z0-9_-]{1,255}\.(\d{1,16})\.json$/;

export const spoolRoot = path.resolve(__dirname, "../logs-pending");

const storage: BunnyZone | undefined = config.replayStorage;

const basePath = String(config.replayStorage?.path ?? "").replace(
  /^\/+|\/+$/g,
  "",
);

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

type LogEntry = { rel: string; time: number; size: number };

const dayOf = (time: number) => new Date(time).toISOString().slice(0, 10);

const remotePath = (rel: string) => (basePath ? `${basePath}/${rel}` : rel);

const remoteDir = (rel: string) =>
  rel ? `${remotePath(rel)}/` : remotePath("");

const timeOf = (name: string): number | null => {
  const match = LOG_NAME.exec(name);
  return match ? Number(match[1]) : null;
};

/** `{YYYY-MM-DD}/{verified|unverified}/{nickname}.{fileName}.{time}.json`, in UTC days. */
export const replayLogPath = (
  nickname: string,
  fileName: string,
  time: number,
  verified: boolean,
) =>
  `${dayOf(time)}/${verified ? "verified" : "unverified"}/${nickname}.${fileName}.${time}.json`;

const byTime = (a: LogEntry, b: LogEntry) => a.time - b.time;

const cutoffTime = () => Date.now() - retentionDays() * MS_PER_DAY;

// ---- Local spool -------------------------------------------------------------

let spooled: LogEntry[] = [];
let spooledBytes = 0;

const spoolFile = (rel: string) => path.join(spoolRoot, rel);

const readDir = async (dir: string) => {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") signale.error(err);
    return [];
  }
};

const scanSpool = async () => {
  const out: LogEntry[] = [];
  for (const day of await readDir(spoolRoot)) {
    if (!day.isDirectory() || !DAY_NAME.test(day.name)) continue;
    for (const kind of KINDS) {
      const dir = path.join(spoolRoot, day.name, kind);
      for (const file of await readDir(dir)) {
        const time = timeOf(file.name);
        if (!file.isFile() || time === null) continue;
        const rel = `${day.name}/${kind}/${file.name}`;
        try {
          const { size } = await fs.stat(spoolFile(rel));
          out.push({ rel, time, size });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT")
            signale.error(err);
        }
      }
    }
  }
  spooled = out.sort(byTime);
  spooledBytes = spooled.reduce((sum, entry) => sum + entry.size, 0);
};

const removeEmptySpoolDirs = async () => {
  for (const day of await readDir(spoolRoot)) {
    if (!day.isDirectory()) continue;
    const dayDir = path.join(spoolRoot, day.name);
    for (const kind of await readDir(dayDir)) {
      if (kind.isDirectory())
        await fs.rmdir(path.join(dayDir, kind.name)).catch(() => {});
    }
    await fs.rmdir(dayDir).catch(() => {});
  }
};

const dropSpooled = async (entry: LogEntry) => {
  try {
    await fs.unlink(spoolFile(entry.rel));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      signale.error(err);
      return false;
    }
  }
  const index = spooled.indexOf(entry);
  if (index !== -1) {
    spooled.splice(index, 1);
    spooledBytes -= entry.size;
  }
  return true;
};

const pruneSpool = async (budget: number) => {
  let removed = 0;
  for (const entry of [...spooled]) {
    if (spooledBytes <= budget) break;
    if (await dropSpooled(entry)) removed++;
  }
  if (removed) {
    await removeEmptySpoolDirs();
    signale.warn(`Removed ${removed} oldest pending replay log(s).`);
  }
};

const writeSpool = async (entry: LogEntry, body: string) => {
  const file = spoolFile(entry.rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
  spooled.push(entry);
  spooledBytes += entry.size;
};

// ---- Remote storage ----------------------------------------------------------

const listDays = async (zone: BunnyZone) => {
  const days: string[] = [];
  for (const object of await listObjects(zone, remoteDir(""))) {
    if (object.IsDirectory && DAY_NAME.test(object.ObjectName))
      days.push(object.ObjectName);
  }
  return days.sort();
};

const removeExpiredInDay = async (
  zone: BunnyZone,
  day: string,
  cutoff: number,
) => {
  let removed = 0;
  for (const kind of KINDS) {
    for (const object of await listObjects(zone, remoteDir(`${day}/${kind}`))) {
      const time = timeOf(object.ObjectName);
      if (object.IsDirectory || time === null || time >= cutoff) continue;
      try {
        await deleteObject(
          zone,
          remotePath(`${day}/${kind}/${object.ObjectName}`),
        );
        removed++;
      } catch (err) {
        signale.error(err);
      }
    }
  }
  return removed;
};

const removeExpiredStored = async (zone: BunnyZone, cutoff: number) => {
  const cutoffDay = dayOf(cutoff);
  let removed = 0;
  for (const day of await listDays(zone)) {
    if (day > cutoffDay) break;
    if (day === cutoffDay) {
      removed += await removeExpiredInDay(zone, day, cutoff);
      continue;
    }
    try {
      await deleteObject(zone, remoteDir(day));
      removed++;
    } catch (err) {
      signale.error(err);
    }
  }
  return removed;
};

const upload = (
  zone: BunnyZone,
  entry: LogEntry,
  body: Uint8Array<ArrayBuffer>,
) => putObject(zone, remotePath(entry.rel), body, "application/json");

let flushing: Promise<void> | null = null;

const flushOnce = async (zone: BunnyZone) => {
  let uploaded = 0;
  for (const entry of [...spooled]) {
    if (!spooled.includes(entry)) continue;
    let body: Buffer;
    try {
      body = await fs.readFile(spoolFile(entry.rel));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") signale.error(err);
      await dropSpooled(entry);
      continue;
    }
    try {
      await upload(zone, entry, new Uint8Array(body));
    } catch (err) {
      signale.warn(
        `Failed to upload replay logs, ${spooled.length} kept in logs-pending.`,
      );
      signale.warn(err);
      return;
    }
    await dropSpooled(entry);
    uploaded++;
  }
  if (uploaded > 1)
    signale.success(`Uploaded ${uploaded} pending replay logs.`);
  await removeEmptySpoolDirs();
};

/** Uploads everything in logs-pending. Does nothing without replayStorage. */
export const flushReplayLogs = () => {
  if (!storage) return Promise.resolve();
  flushing ??= flushOnce(storage).finally(() => {
    flushing = null;
  });
  return flushing;
};

// ---- Public API --------------------------------------------------------------

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

  const serialized = JSON.stringify(record);
  if (serialized === undefined) return true;
  const time = Date.now();
  const entry: LogEntry = {
    rel: replayLogPath(nickname, fileName, time, verified),
    time,
    size: Buffer.byteLength(serialized),
  };

  try {
    await writeSpool(entry, serialized);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOSPC") {
      await pruneSpool(
        Math.floor(spooledBytes * PRUNE_TARGET_RATIO) - entry.size,
      );
    } else {
      signale.error(err);
    }
    try {
      await writeSpool(entry, serialized);
    } catch (retryErr) {
      signale.error(retryErr);
      if (storage) {
        await upload(
          storage,
          entry,
          new Uint8Array(Buffer.from(serialized)),
        ).catch((uploadErr) => signale.error(uploadErr));
      }
      return true;
    }
  }

  if (storage) flushReplayLogs().catch((err) => signale.error(err));
  return true;
};

export const cleanupReplayLogs = async () => {
  const days = retentionDays();
  const cutoff = cutoffTime();
  let removed = 0;

  for (const entry of [...spooled]) {
    if (entry.time < cutoff && (await dropSpooled(entry))) removed++;
  }
  await removeEmptySpoolDirs();

  if (storage) removed += await removeExpiredStored(storage, cutoff);

  if (removed) {
    signale.success(
      `Removed ${removed} expired replay log(s) or day folder(s) older than ${days} day(s).`,
    );
  }
};

export const initReplayLogs = async () => {
  await scanSpool();
  if (!storage) {
    signale.warn(
      "replayStorage is not configured, replay logs are kept only in logs-pending.",
    );
    return;
  }
  await flushReplayLogs();
  setInterval(() => {
    flushReplayLogs().catch((err) => signale.error(err));
  }, FLUSH_INTERVAL_MS).unref();
};
