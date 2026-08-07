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

// 전역 에러 핸들러입니다. 스택 등 내부 정보를 노출하지 않습니다.
// Express는 인자 4개인 미들웨어를 에러 핸들러로 인식하므로 next를 유지해야 합니다.
export const errorHandler = (
  err: unknown,
  req: express.Request,
  res: express.Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: express.NextFunction,
) => {
  signale.error(err);
  if (res.headersSent) return;
  // body-parser가 붙이는 4xx(깨진 JSON 400, 크기 초과 413)를 그대로 씁니다.
  // 전부 500으로 뭉개면 요청 잘못인지 서버 고장인지 구분할 수 없습니다.
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
