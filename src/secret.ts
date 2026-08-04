import { timingSafeEqual } from "crypto";

import config from "./config";

/**
 * 서버 간 통신에 쓰이는 project secret을 검증합니다.
 *
 * 일반 문자열 비교(`!==`)는 첫 불일치 바이트에서 즉시 끝나므로 비교에 걸린 시간이
 * "앞에서 몇 글자가 맞았는지"를 흘립니다. timingSafeEqual로 길이가 같은 버퍼를
 * 상수 시간에 비교하고, 길이가 다르면 비교 자체를 수행하지 않고 실패시킵니다.
 */
export const isValidSecret = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  const expected = Buffer.from(config.project.secretKey, "utf8");
  const actual = Buffer.from(value, "utf8");
  // 길이가 다르면 timingSafeEqual이 예외를 던지므로 먼저 걸러냅니다.
  // (길이 노출은 불가피하지만 내용 노출보다 위험이 훨씬 작습니다.)
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
};
