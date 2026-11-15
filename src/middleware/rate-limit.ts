import express from "express";
import { isIP } from "net";
import signale from "signale";

import { createErrorResponse } from "../api-response";
import { isRedisReady, redisClient } from "../redis";
import { isValidSecret } from "../secret";
import { addressBucket } from "./client-address";

export const SERVICE_KEY_HEADER = "x-urlate-service-key";
export const VISITOR_IP_HEADER = "x-urlate-visitor-ip";

export const clientKey = (req: express.Request): string => {
  const visitor = req.get(VISITOR_IP_HEADER);
  if (visitor && isIP(visitor) && isValidSecret(req.get(SERVICE_KEY_HEADER))) {
    return `visitor:${addressBucket(visitor)}`;
  }
  return addressBucket(req.ip || req.socket.remoteAddress || "unknown");
};

export const rateLimit =
  (options: {
    windowSec: number;
    max: number;
    prefix: string;
    key?: (req: express.Request) => string | undefined;
  }) =>
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
      const key = `ratelimit:${options.prefix}:${options.key?.(req) || clientKey(req)}`;
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
      signale.error(err);
    }
    next();
  };
