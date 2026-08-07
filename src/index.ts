import signale from "signale";
import schedule from "node-schedule";

import { app } from "./app";
import config from "./config";
import { knex } from "./db";
import { scheduleJobs } from "./jobs";
import { redisClient } from "./redis";
import { rebuildRatingIndexIfNeeded } from "./services/rating-bootstrap";

// Node 15+는 처리되지 않은 프로미스 거부에서 프로세스를 종료합니다.
process.on("unhandledRejection", (reason) => {
  signale.error("Unhandled promise rejection:");
  signale.error(reason);
});

// uncaughtException 이후의 상태는 신뢰할 수 없어 pm2 재시작에 맡깁니다.
process.on("uncaughtException", (err) => {
  signale.fatal("Uncaught exception, shutting down:");
  signale.fatal(err);
  process.exit(1);
});

// Redis 연결을 기다리는 상한입니다. node-redis는 무한히 재시도하므로 그대로
// await하면 Redis가 죽어 있는 동안 포트가 아예 열리지 않습니다.
const REDIS_CONNECT_TIMEOUT_MS = 5000;

// Redis 연결을 닫습니다.
const closeRedis = async () => {
  try {
    // 재연결 중인 클라이언트는 isOpen이 true여도 quit()이 정착하지 않으므로
    // isReady일 때만 시도합니다.
    if (redisClient.isReady) {
      await Promise.race([
        redisClient.quit(),
        // unref()를 쓰면 안 됩니다. 남은 핸들이 모두 unref면 타이머가 발화하기
        // 전에 프로세스가 빠져나가 종료 절차가 중간에 끊깁니다.
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
  } catch (err) {
    signale.error(err);
  }
  try {
    if (redisClient.isOpen) redisClient.destroy();
  } catch {
    // 이미 닫혀 있습니다.
  }
};

const start = async () => {
  const connecting = redisClient.connect().catch((err) => {
    // Redis가 없어도 DB 폴백으로 동작하므로 기동은 계속합니다.
    signale.error("Failed to connect to redis on startup.");
    signale.error(err);
  });
  await Promise.race([
    connecting,
    new Promise<void>((resolve) =>
      setTimeout(resolve, REDIS_CONNECT_TIMEOUT_MS).unref(),
    ),
  ]);
  if (!redisClient.isReady) {
    signale.warn(
      "Starting without redis. Cache and rate limit fall back until it recovers.",
    );
  }

  // 첫 프로필 조회부터 ZSET을 쓰도록 미리 준비합니다.
  rebuildRatingIndexIfNeeded().catch((err) => signale.error(err));

  scheduleJobs();

  const server = app.listen(config.project.port, () => {
    signale.info(new Date());
    signale.success(`API Server running at port ${config.project.port}.`);
  });

  // 배포·재시작 시 진행 중인 요청을 끝내고 자원을 정리합니다. 정리 없이
  // 종료하면 커밋되지 않은 트랜잭션이 DB 타임아웃까지 잠금을 붙듭니다.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    signale.pending(`Received ${signal}, shutting down...`);

    // 새 연결을 막고 진행 중인 요청을 기다립니다.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // 종료 중에 예약 작업이 새 쿼리를 시작하지 않도록 멈춥니다.
    await schedule.gracefulShutdown().catch((err) => signale.error(err));
    await knex.destroy().catch((err) => signale.error(err));
    await closeRedis();

    signale.success("Shutdown complete.");
    process.exit(0);
  };

  // 끝나지 않으면 강제 종료합니다. pm2의 kill_timeout보다 짧아야 합니다.
  const SHUTDOWN_TIMEOUT_MS = 10000;
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      setTimeout(() => {
        signale.error("Shutdown timed out, forcing exit.");
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS).unref();
      shutdown(signal).catch((err) => {
        signale.error(err);
        process.exit(1);
      });
    });
  }
};

start().catch((err) => {
  signale.fatal("Failed to start the server.");
  signale.fatal(err);
  process.exit(1);
});
