import signale from "signale";

import { isRedisReady, redisClient } from "./redis";

/**
 * 예약 작업의 중복 실행을 막는 분산 락입니다.
 *
 * node-schedule은 프로세스마다 독립적으로 동작합니다. PM2를 cluster 모드로
 * 올리면 인스턴스 수만큼 같은 작업이 같은 시각에 실행되고, 랭크 갱신에서는
 * 순위가 중복 기록되고 업적도 중복 지급됩니다. 지금은 fork 모드라 드러나지
 * 않지만, 인스턴스를 늘리는 순간 조용히 데이터가 어긋납니다.
 */

// 하루 한 번 도는 작업의 기본 락 유지 시간입니다.
// 다음 실행 전에는 반드시 만료되도록 24시간보다 짧게 잡습니다.
const DEFAULT_TTL_SEC = 23 * 60 * 60;

/**
 * 그날의 실행권을 잡습니다. 락을 얻은 인스턴스만 true를 받습니다.
 *
 * Redis를 쓸 수 없으면 true를 반환합니다. 단일 인스턴스 환경에서 작업이 아예
 * 돌지 않는 것보다는 중복 위험을 감수하는 편이 낫기 때문입니다.
 */
export const acquireDailyJobLock = async (
  jobName: string,
  ttlSec: number = DEFAULT_TTL_SEC,
): Promise<boolean> => {
  if (!isRedisReady()) return true;
  // 날짜를 키에 넣어 매일 새로 잡히도록 합니다.
  const day = new Date().toISOString().slice(0, 10);
  try {
    const result = await redisClient.set(`job:v1:${jobName}:${day}`, "1", {
      NX: true,
      EX: ttlSec,
    });
    if (result !== "OK") {
      signale.info(`Skipping ${jobName}: another instance holds today's lock.`);
      return false;
    }
    return true;
  } catch (err) {
    signale.error(err);
    return true;
  }
};
