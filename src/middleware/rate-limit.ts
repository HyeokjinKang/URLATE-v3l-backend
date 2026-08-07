import express from "express";
import signale from "signale";

import { createErrorResponse } from "../api-response";
import { isRedisReady, redisClient } from "../redis";

// Redis 기반이라 인스턴스를 늘려도 카운터가 공유됩니다.
export const rateLimit =
  (options: { windowSec: number; max: number; prefix: string }) =>
  async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    // 끊겨 있으면 명령마다 예외가 나므로 먼저 확인합니다.
    if (!isRedisReady()) {
      next();
      return;
    }
    try {
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const key = `ratelimit:${options.prefix}:${ip}`;
      const count = await redisClient.incr(key);
      if (count === 1) {
        await redisClient.expire(key, options.windowSec);
      }
      if (count > options.max) {
        res
          .status(429)
          .json(
            createErrorResponse(
              "failed",
              "Too Many Requests",
              "Rate limit exceeded. Please try again later.",
            ),
          );
        return;
      }
    } catch (err) {
      // Redis 장애 시 요청을 막지 않고 통과시킵니다(가용성 우선).
      signale.error(err);
    }
    next();
  };
