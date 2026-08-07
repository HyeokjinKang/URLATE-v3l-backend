import express from "express";
import signale from "signale";

import { createErrorResponse } from "../api-response";
import config from "../config";

/**
 * CSRF 방어입니다. SameSite=lax는 상위 도메인을 공유하는 사이트끼리 쿠키를
 * 그대로 보내므로, Origin(없으면 Referer)을 신뢰 목록과 대조하는 계층을 더 둡니다.
 *
 * 둘 다 없는 요청은 통과시킵니다. 브라우저는 상태 변경 요청에 Origin을 반드시
 * 붙이므로 이 경우는 서버 간 호출이며, 그 경로는 project secret으로 인증합니다.
 */
const CSRF_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const ALLOWED_ORIGINS = new Set(
  [config.project.url, config.project.api].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  ),
);

const toOrigin = (value?: string): string | null => {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

// 브라우저가 아니면 null입니다.
export const requestOrigin = (req: express.Request): string | null =>
  toOrigin(req.get("origin")) ?? toOrigin(req.get("referer"));

export const isAllowedOrigin = (origin: string | null): boolean =>
  origin !== null && ALLOWED_ORIGINS.has(origin);

export const forbiddenOrigin = (res: express.Response) => {
  res
    .status(403)
    .json(
      createErrorResponse(
        "failed",
        "Forbidden Origin",
        "Request origin is not allowed.",
      ),
    );
};

export const csrfGuard = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  if (CSRF_SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  const origin = requestOrigin(req);
  if (origin === null || ALLOWED_ORIGINS.has(origin)) {
    next();
    return;
  }
  signale.warn(
    `Blocked cross-origin ${req.method} ${req.path} from ${origin}.`,
  );
  forbiddenOrigin(res);
};
