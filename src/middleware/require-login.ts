import express from "express";

import { createErrorResponse } from "../api-response";

// Attach to routes that require a login.
// Don't change the response body; the client branches on the result/error fields.
export const requireLogin = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  if (!req.session.userid) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "UserID Required",
          "UserID is required for this task.",
        ),
      );
    return;
  }
  next();
};
