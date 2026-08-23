import express from "express";

import { createErrorResponse } from "../api-response";

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
