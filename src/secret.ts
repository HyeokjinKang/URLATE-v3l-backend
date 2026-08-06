import { timingSafeEqual } from "crypto";

import config from "./config";

// 서버 간 통신용 project secret을 상수 시간에 비교합니다.
// `!==`는 첫 불일치 바이트에서 끝나 비교 시간이 "몇 글자가 맞았는지"를 흘립니다.
export const isValidSecret = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  const expected = Buffer.from(config.project.secretKey, "utf8");
  const actual = Buffer.from(value, "utf8");
  // 길이가 다르면 timingSafeEqual이 예외를 던지므로 먼저 걸러냅니다.
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
};
