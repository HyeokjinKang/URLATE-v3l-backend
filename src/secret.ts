import { timingSafeEqual } from "crypto";

import config from "./config";

// Compares the server-to-server project secret in constant time.
// `!==` short-circuits at the first mismatched byte, leaking how many
// characters matched through timing.
export const isValidSecret = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  const expected = Buffer.from(config.project.secretKey, "utf8");
  const actual = Buffer.from(value, "utf8");
  // timingSafeEqual throws on a length mismatch, so filter that out first.
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
};
