import { timingSafeEqual } from "crypto";

import config from "./config";

export const isValidSecret = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  const expected = Buffer.from(config.project.secretKey, "utf8");
  const actual = Buffer.from(value, "utf8");
  // timingSafeEqual throws on a length mismatch, so filter that out first.
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
};
