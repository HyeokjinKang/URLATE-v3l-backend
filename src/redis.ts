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
  // 연결이 끊긴 동안 명령을 큐에 쌓지 않고 즉시 실패시킵니다.
  //
  // 기본값(큐에 쌓기)에서는 Redis가 죽었을 때 명령이 예외를 던지지 않고 연결이
  // 복구될 때까지 대기합니다. 그래서 "Redis 장애 시 DB로 폴백한다"는 설계와 달리
  // 요청이 응답 없이 매달렸고, Redis 장애가 곧 API 전체 장애가 되었습니다.
  // 즉시 실패하면 각 계층의 try/catch가 의도대로 폴백 경로를 탑니다.
  disableOfflineQueue: true,
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
