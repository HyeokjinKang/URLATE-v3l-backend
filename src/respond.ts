import express from "express";

import { createErrorResponse } from "./api-response";

// Shared response for a lookup target that doesn't exist.
export const notFound = (res: express.Response, description: string) => {
  res
    .status(400)
    .json(createErrorResponse("failed", "Failed to Load", description));
};
