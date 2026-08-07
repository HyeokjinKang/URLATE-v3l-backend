import cookieParser from "cookie-parser";
import express from "express";

import { csrfGuard } from "./middleware/csrf";
import { errorHandler, notFoundHandler } from "./middleware/errors";
import { ensureBody, securityHeaders } from "./middleware/headers";
import { rateLimit } from "./middleware/rate-limit";
import { sessionMiddleware } from "./middleware/session";
import { router as authRouter } from "./routes/auth";
import { router as couponRouter } from "./routes/coupon";
import { router as noticeRouter } from "./routes/notice";
import { router as rankingRouter } from "./routes/ranking";
import { router as recordsRouter } from "./routes/records";
import { router as tracksRouter } from "./routes/tracks";
import { router as usersRouter } from "./routes/users";

export const app = express();
app.locals.pretty = true;

// 버전 노출을 막습니다.
app.disable("x-powered-by");

// HTTPS를 종단하는 프록시 뒤이므로 X-Forwarded-Proto를 신뢰해야 secure 쿠키가 동작합니다.
app.set("trust proxy", 1);

app.use(securityHeaders);

// 차단될 요청이 세션 조회와 본문 파싱 비용을 치르지 않도록 앞에 둡니다.
app.use(rateLimit({ windowSec: 60, max: 600, prefix: "global" }));

app.use(sessionMiddleware);
// 가장 큰 본문인 리플레이 로그를 담을 수 있는 선으로 고정합니다(기본값은 100kb).
app.use(express.json({ limit: "512kb" }));
app.use(express.urlencoded({ extended: true, limit: "64kb" }));
app.use(cookieParser());

app.use(ensureBody);

app.use(csrfGuard);

app.use(authRouter);
app.use(usersRouter);
app.use(tracksRouter);
app.use(recordsRouter);
app.use(couponRouter);
app.use(rankingRouter);
app.use(noticeRouter);

// 라우터 뒤에 와야 합니다. 앞에 두면 모든 요청이 404로 끝납니다.
app.use(notFoundHandler);

app.use(errorHandler);
