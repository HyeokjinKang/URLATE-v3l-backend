import settingsConfig from "../config/settings.json";

// Normalizes user settings against the defaults (config/settings.json) as a
// schema, so the stored keys and size are always the same shape.

type SettingsValue = string | number | boolean | SettingsObject;
interface SettingsObject {
  [key: string]: SettingsValue;
}

// Length cap for free-input strings (e.g. skin names).
const MAX_STRING_LENGTH = 64;

const isPlainObject = (value: unknown): value is SettingsObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Drops keys not in the template; fills in the default for missing or type-mismatched values.
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
