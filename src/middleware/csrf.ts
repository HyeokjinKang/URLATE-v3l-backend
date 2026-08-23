import express from "express";
import signale from "signale";

import { createErrorResponse } from "../api-response";
import config from "../config";

// SameSite=lax still sends cookies between sites sharing a parent domain, so
// Origin (falling back to Referer) is checked against an allowlist.
//
// A request with neither is let through: browsers always attach Origin on a
// state-changing request, so that case is a server-to-server call, which
// authenticates with the project secret instead.
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

// Null for a non-browser caller.
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
