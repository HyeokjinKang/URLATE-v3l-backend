import { createClient } from "redis";
import signale from "signale";

import config from "./config";

export const redisClient = createClient({
  socket: {
    host: config.redis.host,
    port: config.redis.port,
  },
  username: config.redis.username,
  password: config.redis.password,
  // Required: with the default (offline queue), a dropped connection makes
  // commands wait for recovery instead of throwing, so each layer's DB
  // fallback never kicks in and requests just hang.
  disableOfflineQueue: true,
});

redisClient.on("connect", () => {
  signale.success("Connected to redis server.");
});

redisClient.on("error", (err) => {
  signale.error(err);
});

export const isRedisReady = (): boolean => redisClient.isReady;
