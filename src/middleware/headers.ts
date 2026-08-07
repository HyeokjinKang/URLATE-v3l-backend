import express from "express";

// CORS 헤더는 프록시가 담당합니다. 여기서도 넣으면 중복되어 브라우저가 차단합니다.
export const securityHeaders = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // 본인 데이터(/user 등)가 공유 캐시에 남지 않도록 합니다.
  res.setHeader("Cache-Control", "no-store");
  next();
};

// Express 5는 본문 파서가 처리하지 못한 요청의 req.body를 undefined로 둡니다
// (Express 4는 {}). 라우트가 req.body.x를 곧바로 읽으므로 Content-Type 하나만
// 어긋나도 400이어야 할 응답이 TypeError로 500이 됩니다.
export const ensureBody = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  if (req.body === undefined) req.body = {};
  next();
};
