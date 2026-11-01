import fetch from "node-fetch";

import { getOrSet, keys } from "../cache";
import config from "../config";

const PATTERN_TIMEOUT_MS = 5000;

const patternUrl = (fileName: string, selection: number) =>
  `${config.project.cdn}/URLATE-patterns/${fileName}/${selection}.json`;

const fetchPatternExists = async (
  fileName: string,
  selection: number,
): Promise<boolean> => {
  const response = await fetch(patternUrl(fileName, selection), {
    signal: AbortSignal.timeout(PATTERN_TIMEOUT_MS),
  });
  if (response.status === 403 || response.status === 404) return false;
  if (!response.ok) {
    throw new Error(`Pattern CDN responded ${response.status}.`);
  }
  try {
    const pattern = (await response.json()) as { patterns?: unknown } | null;
    return Array.isArray(pattern?.patterns);
  } catch {
    return false;
  }
};

export const patternExists = (fileName: string, selection: number) =>
  getOrSet("pattern", keys.pattern(fileName, selection), () =>
    fetchPatternExists(fileName, selection),
  );
