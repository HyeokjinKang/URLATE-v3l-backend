import express from "express";

import { createErrorResponse } from "../api-response";

// 로그인이 필요한 라우트에 붙입니다.
// 응답 본문은 바꾸지 마세요. 클라이언트가 result/error 필드로 분기합니다.
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
