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

const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

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

// ---- Legacy logs -------------------------------------------------------------

// TODO: Remove once production has moved logs/ and logs-unverified/ to storage.
const legacyRoots = [
  { root: path.resolve(__dirname, "../logs"), verified: true },
  { root: path.resolve(__dirname, "../logs-unverified"), verified: false },
];

const LEGACY_NAME = /^(\d{1,16})\.json$/;

const adoptLegacyLogs = async () => {
  const cutoff = cutoffTime();
  let moved = 0;
  let expired = 0;
  for (const { root, verified } of legacyRoots) {
    for (const user of await readDir(root)) {
      if (!user.isDirectory() || !SAFE_SEGMENT.test(user.name)) continue;
      const userDir = path.join(root, user.name);
      for (const track of await readDir(userDir)) {
        if (!track.isDirectory() || !SAFE_SEGMENT.test(track.name)) continue;
        const trackDir = path.join(userDir, track.name);
        for (const file of await readDir(trackDir)) {
          const match = LEGACY_NAME.exec(file.name);
          const source = path.join(trackDir, file.name);
          try {
            if (!file.isFile() || !match) continue;
            const time = Number(match[1]);
            if (time < cutoff) {
              await fs.unlink(source);
              expired++;
              continue;
            }
            const target = spoolFile(
              replayLogPath(user.name, track.name, time, verified),
            );
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.rename(source, target);
            moved++;
          } catch (err) {
            signale.error(err);
          }
        }
        await fs.rmdir(trackDir).catch(() => {});
      }
      await fs.rmdir(userDir).catch(() => {});
    }
    await fs.rmdir(root).catch(() => {});
  }
  if (moved || expired) {
    signale.info(
      `Moved ${moved} legacy replay log(s) to logs-pending, removed ${expired} expired.`,
    );
  }
};

// ---- Remote storage ----------------------------------------------------------

let stored: LogEntry[] = [];
let storedBytes = 0;
let uploadedDuringScan: LogEntry[] | null = null;

const addStored = (entry: LogEntry) => {
  uploadedDuringScan?.push(entry);
  stored.push(entry);
  storedBytes += entry.size;
  if (stored.length > 1 && stored[stored.length - 2].time > entry.time)
    stored.sort(byTime);
};

const scanStorage = async (zone: BunnyZone) => {
  const out: LogEntry[] = [];
  const days: string[] = [];
  for (const object of await listObjects(zone, remoteDir(""))) {
    if (object.IsDirectory && DAY_NAME.test(object.ObjectName))
      days.push(object.ObjectName);
  }
  for (const day of days.sort()) {
    for (const kind of KINDS) {
      for (const object of await listObjects(
        zone,
        remoteDir(`${day}/${kind}`),
      )) {
        const time = timeOf(object.ObjectName);
        if (object.IsDirectory || time === null) continue;
        out.push({
          rel: `${day}/${kind}/${object.ObjectName}`,
          time,
          size: object.Length,
        });
      }
    }
  }
  return { days, entries: out.sort(byTime) };
};

const rebuildStored = async (zone: BunnyZone) => {
  const uploaded: LogEntry[] = [];
  uploadedDuringScan = uploaded;
  let scanned;
  try {
    scanned = await scanStorage(zone);
  } finally {
    uploadedDuringScan = null;
  }
  const { days, entries } = scanned;
  const known = new Set(entries.map((entry) => entry.rel));
  for (const entry of uploaded) {
    if (!known.has(entry.rel)) entries.push(entry);
  }
  stored = entries.sort(byTime);
  storedBytes = stored.reduce((sum, entry) => sum + entry.size, 0);
  return days;
};

const pruneStored = async (zone: BunnyZone, budget: number) => {
  let removed = 0;
  while (storedBytes > budget && stored.length) {
    const entry = stored[0];
    try {
      await deleteObject(zone, remotePath(entry.rel));
    } catch (err) {
      signale.error(err);
      break;
    }
    stored.shift();
    storedBytes -= entry.size;
    removed++;
  }
  if (removed) {
    signale.warn(
      `Removed ${removed} oldest replay log(s) to stay under ${maxTotalBytes()} bytes.`,
    );
  }
};

let pruning: Promise<void> | null = null;

const makeRoom = (zone: BunnyZone) => {
  if (storedBytes <= maxTotalBytes()) return Promise.resolve();
  pruning ??= pruneStored(
    zone,
    Math.floor(maxTotalBytes() * PRUNE_TARGET_RATIO),
  ).finally(() => {
    pruning = null;
  });
  return pruning;
};

const upload = async (
  zone: BunnyZone,
  entry: LogEntry,
  body: Uint8Array<ArrayBuffer>,
) => {
  await putObject(zone, remotePath(entry.rel), body, "application/json");
  addStored(entry);
  await makeRoom(zone);
};

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

  if (storage) {
    flushReplayLogs().catch((err) => signale.error(err));
  } else if (spooledBytes > maxTotalBytes()) {
    await pruneSpool(Math.floor(maxTotalBytes() * PRUNE_TARGET_RATIO));
  }
  return true;
};

export const cleanupReplayLogs = async () => {
  const days = retentionDays();
  const cutoff = cutoffTime();
  const cutoffDay = dayOf(cutoff);
  let removed = 0;

  for (const entry of [...spooled]) {
    if (entry.time < cutoff && (await dropSpooled(entry))) removed++;
  }
  await removeEmptySpoolDirs();

  if (storage) {
    const remoteDays = await rebuildStored(storage);
    for (const day of remoteDays) {
      if (day >= cutoffDay) continue;
      try {
        await deleteObject(storage, remoteDir(day));
      } catch (err) {
        signale.error(err);
        continue;
      }
      const left = stored.filter((entry) => !entry.rel.startsWith(`${day}/`));
      removed += stored.length - left.length;
      stored = left;
    }
    for (const entry of stored.filter((entry) => entry.time < cutoff)) {
      try {
        await deleteObject(storage, remotePath(entry.rel));
      } catch (err) {
        signale.error(err);
        continue;
      }
      stored.splice(stored.indexOf(entry), 1);
      removed++;
    }
    storedBytes = stored.reduce((sum, entry) => sum + entry.size, 0);
    await pruneStored(storage, maxTotalBytes());
  } else {
    await pruneSpool(maxTotalBytes());
  }

  if (removed) {
    signale.success(
      `Removed ${removed} replay log(s) older than ${days} day(s).`,
    );
  }
};

export const initReplayLogs = async () => {
  await adoptLegacyLogs();
  await scanSpool();
  if (!storage) {
    signale.warn(
      "replayStorage is not configured, replay logs are kept only in logs-pending.",
    );
    return;
  }
  try {
    await rebuildStored(storage);
  } catch (err) {
    signale.error(err);
  }
  await flushReplayLogs();
  setInterval(() => {
    flushReplayLogs().catch((err) => signale.error(err));
  }, FLUSH_INTERVAL_MS).unref();
};
