import fs from "fs-extra";
import path from "path";
import signale from "signale";

import config from "./config";

/**
 * 플레이 리플레이 로그의 기록과 보존 정책입니다.
 *
 * 이전에는 플레이 1회당 파일 하나를 남기기만 하고 정리하는 경로가 없었습니다.
 * 로그는 무한히 쌓이고, 디스크가 차면 로그뿐 아니라 서버 전체가 멈춥니다.
 */

// 설정이 없을 때 사용하는 기본 보관 일수입니다.
const DEFAULT_RETENTION_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
 * 리플레이 로그를 기록합니다.
 *
 * nickname과 fileName은 호출부에서 형식 검증을 마친 값이어야 합니다. 여기서도
 * 최종 경로가 로그 루트 하위인지 다시 확인해 경로 순회를 이중으로 막습니다.
 * 쓰기는 응답을 막지 않도록 기다리지 않고, 실패는 로그만 남깁니다.
 */
export const writeReplayLog = (
  nickname: string,
  fileName: string,
  record: unknown,
): boolean => {
  // 보관 일수가 0이면 아예 남기지 않습니다.
  if (retentionDays() === 0) return true;
  // 리플레이가 없는 제출은 빈 파일을 만들지 않습니다.
  if (record === undefined || record === null) return true;

  const logDir = path.resolve(logsRoot, nickname, fileName);
  if (logDir !== logsRoot && !logDir.startsWith(logsRoot + path.sep)) {
    return false;
  }
  const logFile = path.join(logDir, `${Date.now()}.json`);
  fs.outputJson(logFile, record).catch((err) => signale.error(err));
  return true;
};

/**
 * 보관 기간이 지난 로그 파일을 지우고, 비게 된 디렉터리도 함께 정리합니다.
 * 디렉터리를 순회하며 파일 단위로 처리하므로 메모리를 일정하게 유지합니다.
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
      // 로그 디렉터리가 아직 없을 수 있습니다(정상).
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
        // 개별 파일 실패가 정리 작업 전체를 멈추지 않게 합니다.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") signale.error(err);
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
