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
import { router as miraiRouter } from "./routes/mirai";
import { router as rankingRouter } from "./routes/ranking";
import { router as recordsRouter } from "./routes/records";
import { router as tracksRouter } from "./routes/tracks";
import { router as usersRouter } from "./routes/users";

export const app = express();
app.locals.pretty = true;

app.disable("x-powered-by");

// The proxy terminates HTTPS, so X-Forwarded-Proto must be trusted for secure
// cookies, and req.ip (used by rate limiting) comes from X-Forwarded-For.
//
// Must exactly match the real hop count -- Express takes req.ip by skipping
// this many addresses from the end of X-Forwarded-For. Deployment is CDN +
// reverse proxy, 2 hops; setting 1 would pin req.ip to the CDN and put every
// user in one rate-limit bucket.
app.set("trust proxy", config.project.trustProxy ?? 2);

app.use(securityHeaders);

app.use(rateLimit({ windowSec: 60, max: 600, prefix: "global" }));

app.use(sessionMiddleware);
app.use(express.json({ limit: "512kb" }));
app.use(express.urlencoded({ extended: true, limit: "64kb" }));
app.use(cookieParser());

app.use(ensureBody);

app.use(csrfGuard);

app.get("/", (req, res) => {
  res.send("Hello from API server!");
});

app.use(authRouter);
app.use(usersRouter);
app.use(tracksRouter);
app.use(recordsRouter);
app.use(couponRouter);
app.use(rankingRouter);
app.use(miraiRouter);

// Must come after the routers; placed earlier, every request would end in a 404.
app.use(notFoundHandler);

app.use(errorHandler);
