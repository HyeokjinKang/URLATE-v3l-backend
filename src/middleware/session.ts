import session from "express-session";
import { RedisStore } from "connect-redis";

import config from "../config";
import { redisClient } from "../redis";

const redisStore = new RedisStore({
  client: redisClient,
  prefix: "urlate:",
});

// 로컬 HTTP 개발용으로 test 모드에서만 secure 쿠키를 해제합니다.
export const isProduction = config.project.mode !== "test";

export const sessionMiddleware = session({
  store: redisStore,
  resave: config.session.resave ?? false,
  saveUninitialized: config.session.saveUninitialized ?? false,
  secret: config.session.secret,
  name: "urlate",
  cookie: {
    domain: config.session.domain,
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24 * 14, // 14일
  },
});
