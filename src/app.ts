import cookieParser from "cookie-parser";
import express from "express";

import config from "./config";
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

// 앞단 프록시가 HTTPS를 종단하므로 X-Forwarded-Proto를 신뢰해야 secure 쿠키가
// 동작하고, 레이트리밋이 쓰는 req.ip도 X-Forwarded-For에서 나옵니다.
//
// 이 값은 실제 홉 수와 정확히 같아야 합니다. Express는 X-Forwarded-For의 뒤에서
// 이 개수만큼을 건너뛴 주소를 req.ip로 씁니다. 프론트엔드는 CDN + 리버스 프록시
// 2홉을 확인해 두었고(config.project.trustProxy), 여기서 1을 쓰면 req.ip가
// CDN 주소로 고정되어 전 사용자가 하나의 레이트리밋 버킷을 공유합니다.
app.set("trust proxy", config.project.trustProxy ?? 2);

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
