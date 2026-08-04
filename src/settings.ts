import settingsConfig from "../config/settings.json";

/**
 * 사용자 설정 검증입니다.
 *
 * PUT /settings는 클라이언트가 보낸 값을 그대로 JSON.stringify해서 저장했습니다.
 * 임의의 키와 크기를 가진 객체가 users.settings에 들어갈 수 있었고, 값이
 * undefined면 knex가 "Undefined binding"으로 실패해 500이 났습니다.
 *
 * 기본 설정(config/settings.json)을 스키마 삼아 제출값을 정규화합니다.
 * 결과는 항상 기본 설정과 같은 구조이므로 저장되는 내용과 크기가 고정됩니다.
 */

type SettingsValue = string | number | boolean | SettingsObject;
interface SettingsObject {
  [key: string]: SettingsValue;
}

// 자유 입력 문자열(스킨 이름 등)의 길이 상한입니다.
const MAX_STRING_LENGTH = 64;

const isPlainObject = (value: unknown): value is SettingsObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * template의 각 키를 훑으며 input의 대응 값을 받아들일지 결정합니다.
 * 타입이 다르거나 값이 없으면 기본값을 씁니다. template에 없는 키는 버립니다.
 */
const normalize = (
  template: SettingsObject,
  input: unknown,
): SettingsObject => {
  const source = isPlainObject(input) ? input : {};
  const result: SettingsObject = {};
  for (const [key, fallback] of Object.entries(template)) {
    const submitted = source[key];
    if (isPlainObject(fallback)) {
      result[key] = normalize(fallback, submitted);
      continue;
    }
    if (typeof fallback === "number") {
      result[key] =
        typeof submitted === "number" && Number.isFinite(submitted)
          ? submitted
          : fallback;
      continue;
    }
    if (typeof fallback === "boolean") {
      result[key] = typeof submitted === "boolean" ? submitted : fallback;
      continue;
    }
    // 남은 타입은 문자열입니다.
    result[key] =
      typeof submitted === "string" && submitted.length <= MAX_STRING_LENGTH
        ? submitted
        : fallback;
  }
  return result;
};

export const normalizeSettings = (input: unknown): SettingsObject =>
  normalize(settingsConfig as SettingsObject, input);

export const defaultSettings = (): SettingsObject =>
  settingsConfig as SettingsObject;
