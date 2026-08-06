import { createClient } from "redis";
import signale from "signale";

import config from "./config";

// 세션 저장소·rate limiter·캐시가 이 커넥션 하나를 공유합니다.
export const redisClient = createClient({
  socket: {
    host: config.redis.host,
    port: config.redis.port,
  },
  username: config.redis.username,
  password: config.redis.password,
  // 필수: 기본값(오프라인 큐)에서는 연결이 끊겨도 명령이 예외를 던지지 않고
  // 복구될 때까지 대기해, 각 계층의 DB 폴백이 동작하지 않고 요청이 매달립니다.
  disableOfflineQueue: true,
});

redisClient.on("connect", () => {
  signale.success("Connected to redis server.");
});

redisClient.on("error", (err) => {
  signale.error(err);
});

export const isRedisReady = (): boolean => redisClient.isReady;
