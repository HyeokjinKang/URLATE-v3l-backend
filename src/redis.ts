import { createClient } from "redis";
import signale from "signale";

import config from "./config";

// 세션 저장소·rate limiter·캐시가 하나의 커넥션을 공유합니다.
export const redisClient = createClient({
  socket: {
    host: config.redis.host,
    port: config.redis.port,
  },
  username: config.redis.username,
  password: config.redis.password,
});

redisClient.on("connect", () => {
  signale.success("Connected to redis server.");
});

redisClient.on("error", (err) => {
  signale.error(err);
});

// Redis가 끊겨 있을 때 명령을 보내면 예외가 발생하므로,
// 캐시 계층은 항상 이 값을 먼저 확인하고 DB로 폴백합니다.
export const isRedisReady = (): boolean => redisClient.isReady;
