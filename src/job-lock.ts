import signale from "signale";

import { isRedisReady, redisClient } from "./redis";

const DEFAULT_TTL_SEC = 23 * 60 * 60;

// Claims today's run of a once-daily job; only the lock winner gets true.
// node-schedule runs per process, so PM2 cluster mode would otherwise fire the
// job once per instance. Returns true if Redis is unavailable -- a duplicate
// run beats no run at all.
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
