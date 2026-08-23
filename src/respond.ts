import express from "express";

import { createErrorResponse } from "./api-response";

export const notFound = (res: express.Response, description: string) => {
  res
    .status(400)
    .json(createErrorResponse("failed", "Failed to Load", description));
};
