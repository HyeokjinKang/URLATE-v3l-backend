import express from "express";
import signale from "signale";

import { createErrorResponse } from "../api-response";
import { isRedisReady, redisClient } from "../redis";

export const rateLimit =
  (options: { windowSec: number; max: number; prefix: string }) =>
  async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
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
      // Let the request through on a Redis failure; availability over strict limiting.
      signale.error(err);
    }
    next();
  };
