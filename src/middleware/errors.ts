import express from "express";
import signale from "signale";

import { createErrorResponse } from "../api-response";

export const notFoundHandler = (
  req: express.Request,
  res: express.Response,
) => {
  res
    .status(404)
    .json(createErrorResponse("failed", "Not Found", "Unknown endpoint."));
};

// Express identifies an error handler by its 4-argument signature, so next must stay.
export const errorHandler = (
  err: unknown,
  req: express.Request,
  res: express.Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: express.NextFunction,
) => {
  signale.error(err);
  if (res.headersSent) return;
  const status =
    (err as { status?: number; statusCode?: number } | null)?.status ??
    (err as { statusCode?: number } | null)?.statusCode;
  const isClientError =
    typeof status === "number" && status >= 400 && status < 500;
  res
    .status(isClientError ? status : 500)
    .json(
      isClientError
        ? createErrorResponse(
            "failed",
            "Bad Request",
            "Request could not be processed.",
          )
        : createErrorResponse(
            "failed",
            "Internal Server Error",
            "An unexpected error occurred.",
          ),
    );
};
