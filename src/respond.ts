import express from "express";

import { createErrorResponse } from "./api-response";

// 조회 대상이 없을 때 공통으로 쓰는 응답입니다.
export const notFound = (res: express.Response, description: string) => {
  res
    .status(400)
    .json(createErrorResponse("failed", "Failed to Load", description));
};
