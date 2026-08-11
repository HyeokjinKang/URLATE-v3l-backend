import fs from "fs-extra";
import path from "path";
import signale from "signale";

import config from "./config";

// 플레이 리플레이 로그의 기록과 보존 정책입니다.
// 플레이 1회당 파일 하나가 쌓이므로 정리 경로가 없으면 디스크가 찹니다.

// config에 값이 없을 때 쓰는 기본 보관 일수입니다.
const DEFAULT_RETENTION_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// 리플레이 한 건의 크기 상한입니다. 한 판의 판정 배열은 크기가 뻔하므로,
// 상한이 없으면 본문 제한(512KB)까지 그대로 파일로 쌓여 디스크가 찹니다.
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

/**
 * 리플레이 로그를 기록합니다. 경로가 로그 루트를 벗어나면 false를 돌려줍니다.
 * nickname과 fileName은 호출부에서 형식 검증을 마친 값이어야 하며, 여기서
 * 한 번 더 확인해 경로 순회를 이중으로 막습니다.
 */
export const writeReplayLog = (
  nickname: string,
  fileName: string,
  record: unknown,
): boolean => {
  // 보관 일수가 0이면 남기지 않습니다.
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

/**
 * 보관 기간이 지난 로그와 비게 된 디렉터리를 정리합니다.
 * 파일 단위로 순회하므로 로그가 많아도 메모리 사용량이 일정합니다.
 */
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
      // 로그 디렉터리가 아직 없을 수 있습니다.
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
        // 파일 하나가 실패해도 나머지 정리는 계속합니다.
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
