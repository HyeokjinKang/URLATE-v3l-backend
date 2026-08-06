import settingsConfig from "../config/settings.json";

// 기본 설정(config/settings.json)을 스키마 삼아 사용자 설정을 정규화합니다.
// 결과가 항상 같은 구조이므로 저장되는 키와 크기가 고정됩니다.

type SettingsValue = string | number | boolean | SettingsObject;
interface SettingsObject {
  [key: string]: SettingsValue;
}

// 자유 입력 문자열(스킨 이름 등)의 길이 상한입니다.
const MAX_STRING_LENGTH = 64;

const isPlainObject = (value: unknown): value is SettingsObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// template에 없는 키는 버리고, 타입이 다르거나 없는 값은 기본값으로 채웁니다.
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
