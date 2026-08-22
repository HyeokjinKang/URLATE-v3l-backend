import express from "express";

// CORS headers are handled by the proxy; adding them here too would duplicate them and get blocked by the browser.
export const securityHeaders = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // Keeps personal data (e.g. /user) out of shared caches.
  res.setHeader("Cache-Control", "no-store");
  next();
};

// Express 5 leaves req.body undefined when the body parser can't handle a
// request (Express 4 used {}). Routes read req.body.x directly, so a single
// mismatched Content-Type would turn what should be a 400 into a TypeError-driven 500.
export const ensureBody = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  if (req.body === undefined) req.body = {};
  next();
};
