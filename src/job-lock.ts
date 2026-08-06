import signale from "signale";

import { isRedisReady, redisClient } from "./redis";

// 다음 실행 전에 반드시 만료되도록 24시간보다 짧게 잡습니다.
const DEFAULT_TTL_SEC = 23 * 60 * 60;

/**
 * 하루 한 번 도는 작업의 그날 실행권을 잡습니다. 락을 얻은 쪽만 true를 받습니다.
 *
 * node-schedule은 프로세스마다 독립적으로 돌기 때문에, PM2 cluster 모드에서는
 * 인스턴스 수만큼 같은 작업이 실행됩니다.
 *
 * Redis를 쓸 수 없으면 true를 반환합니다. 작업이 아예 돌지 않는 것보다
 * 중복 위험을 감수하는 편이 낫다고 판단했습니다.
 */
export const acquireDailyJobLock = async (
  jobName: string,
  ttlSec: number = DEFAULT_TTL_SEC,
): Promise<boolean> => {
  if (!isRedisReady()) return true;
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
