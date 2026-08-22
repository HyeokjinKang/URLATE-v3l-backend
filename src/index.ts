import signale from "signale";
import schedule from "node-schedule";

import { app } from "./app";
import config from "./config";
import { knex } from "./db";
import { scheduleJobs } from "./jobs";
import { redisClient } from "./redis";
import { rebuildRatingIndexIfNeeded } from "./services/rating-bootstrap";

// Node 15+ terminates the process on an unhandled promise rejection.
process.on("unhandledRejection", (reason) => {
  signale.error("Unhandled promise rejection:");
  signale.error(reason);
});

// State after uncaughtException can't be trusted, so let pm2 restart the process.
process.on("uncaughtException", (err) => {
  signale.fatal("Uncaught exception, shutting down:");
  signale.fatal(err);
  process.exit(1);
});

// Cap on how long to wait for Redis to connect. node-redis retries forever,
// so awaiting it directly would keep the port from ever opening while Redis
// is down.
const REDIS_CONNECT_TIMEOUT_MS = 5000;

const closeRedis = async () => {
  try {
    // A reconnecting client can have isOpen true but never settle quit(), so
    // only attempt it when isReady.
    if (redisClient.isReady) {
      await Promise.race([
        redisClient.quit(),
        // Don't use unref() here -- if every remaining handle is unref'd, the
        // process could exit before this timer fires, cutting shutdown short.
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
  } catch (err) {
    signale.error(err);
  }
  try {
    if (redisClient.isOpen) redisClient.destroy();
  } catch {
    // Already closed.
  }
};

const start = async () => {
  const connecting = redisClient.connect().catch((err) => {
    // Startup continues even without Redis; falls back to the DB.
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

  // Warm this up so the ZSET is ready for the very first profile lookup.
  rebuildRatingIndexIfNeeded().catch((err) => signale.error(err));

  scheduleJobs();

  // Defaults to loopback since a reverse proxy sits in front. Binding to a
  // wildcard address would expose the port directly, regardless of firewall
  // policy.
  const host = config.project.host ?? "127.0.0.1";
  const server = app.listen(config.project.port, host, () => {
    signale.info(new Date());
    signale.success(`API Server running at ${host}:${config.project.port}.`);
  });

  // Drains in-flight requests and cleans up resources on deploy/restart.
  // Exiting without this would leave uncommitted transactions holding locks
  // until the DB times them out.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    signale.pending(`Received ${signal}, shutting down...`);

    // Stop accepting new connections and wait for in-flight requests.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Stop scheduled jobs so none start a new query during shutdown.
    await schedule.gracefulShutdown().catch((err) => signale.error(err));
    await knex.destroy().catch((err) => signale.error(err));
    await closeRedis();

    signale.success("Shutdown complete.");
    process.exit(0);
  };

  // Force exit if shutdown doesn't finish in time; must be shorter than pm2's kill_timeout.
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
