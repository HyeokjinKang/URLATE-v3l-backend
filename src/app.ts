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

// Avoid exposing the framework/version.
app.disable("x-powered-by");

// The proxy in front terminates HTTPS, so X-Forwarded-Proto has to be
// trusted for secure cookies to work, and req.ip (used by rate limiting)
// comes from X-Forwarded-For too.
//
// This value must exactly match the real hop count. Express takes req.ip
// from X-Forwarded-For by skipping this many addresses from the end. The
// frontend sits behind CDN + reverse proxy, 2 hops (config.project.trustProxy).
// Setting this to 1 would pin req.ip to the CDN's address, and every user
// would share a single rate-limit bucket.
app.set("trust proxy", config.project.trustProxy ?? 2);

app.use(securityHeaders);

// Placed early so a request that's about to be blocked doesn't pay for
// session lookup and body parsing first.
app.use(rateLimit({ windowSec: 60, max: 600, prefix: "global" }));

app.use(sessionMiddleware);
// Capped to fit the largest body, the replay log (default is 100kb).
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

// Must come after the routers; placed earlier, every request would end in a 404.
app.use(notFoundHandler);

app.use(errorHandler);
