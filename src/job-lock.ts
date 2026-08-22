import signale from "signale";

import { isRedisReady, redisClient } from "./redis";

// Kept under 24 hours so the lock always expires before the next run.
const DEFAULT_TTL_SEC = 23 * 60 * 60;

/**
 * Claims the right to run a once-daily job for today. Only the caller that
 * wins the lock gets true back.
 *
 * node-schedule runs independently per process, so under PM2 cluster mode
 * the same job would fire once per instance.
 *
 * Returns true if Redis is unavailable. Better to accept the risk of a
 * duplicate run than have the job not run at all.
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
