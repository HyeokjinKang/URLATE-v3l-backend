/** Must match URLATE public/modules/pattern.js (Timing, parsePattern). */

const BPM_TRIGGER = 2;

interface BpmSegment {
  beat: number;
  from: number;
  to: number;
  duration: number;
  ms: number;
}

const toNumber = (value: unknown, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const minorVersion = (pattern: Record<string, unknown>) => {
  const information = pattern.information as
    Record<string, unknown> | undefined;
  const minor = parseInt(
    String(information?.version ?? "1.0").split(".")[1] ?? "0",
    10,
  );
  return Number.isNaN(minor) ? 0 : minor;
};

const valueIn = (segment: BpmSegment, beat: number) => {
  if (segment.duration <= 0 || beat >= segment.beat + segment.duration)
    return segment.to;
  return (
    segment.from +
    ((segment.to - segment.from) * (beat - segment.beat)) / segment.duration
  );
};

const msIn = (segment: BpmSegment, beat: number) => {
  const span = beat - segment.beat;
  if (segment.duration <= 0) return (span * 60000) / segment.to;
  const rampSpan = Math.min(span, segment.duration);
  const slope = (segment.to - segment.from) / segment.duration;
  const rampMs =
    slope === 0
      ? (rampSpan * 60000) / segment.from
      : (60000 / slope) *
        Math.log(valueIn(segment, segment.beat + rampSpan) / segment.from);
  return rampMs + (Math.max(span - segment.duration, 0) * 60000) / segment.to;
};

const beatIn = (segment: BpmSegment, ms: number) => {
  const elapsed = ms - segment.ms;
  if (segment.duration > 0) {
    const rampMs = msIn(segment, segment.beat + segment.duration);
    if (elapsed < rampMs) {
      const slope = (segment.to - segment.from) / segment.duration;
      if (slope === 0) return segment.beat + (elapsed * segment.from) / 60000;
      return (
        segment.beat +
        (segment.from * Math.expm1((elapsed * slope) / 60000)) / slope
      );
    }
    return (
      segment.beat +
      segment.duration +
      ((elapsed - rampMs) * segment.to) / 60000
    );
  }
  return segment.beat + (elapsed * segment.to) / 60000;
};

const lastAtOrBefore = (
  segments: BpmSegment[],
  key: "beat" | "ms",
  value: number,
) => {
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (segments[mid][key] <= value) low = mid + 1;
    else high = mid;
  }
  return low - 1;
};

export interface PatternTiming {
  /** Song time in ms (before the pattern offset) at which `beat` is reached. */
  msAt: (beat: number) => number;
  /** Beat reached at `ms` of song time (before the pattern offset). */
  beatAt: (ms: number) => number;
}

export const createTiming = (
  pattern: Record<string, unknown>,
): PatternTiming => {
  const information = pattern.information as Record<string, unknown>;
  const baseBpm = toNumber(information?.bpm);
  const gradual = minorVersion(pattern) >= 1;
  const triggers = Array.isArray(pattern.triggers) ? pattern.triggers : [];

  const segments: BpmSegment[] = [];
  for (const trigger of triggers) {
    if (toNumber(trigger?.value, -1) !== BPM_TRIGGER) continue;
    const previous = segments[segments.length - 1];
    const beat = toNumber(trigger.beat);
    segments.push({
      beat,
      from: previous ? valueIn(previous, beat) : baseBpm,
      to: toNumber(trigger.bpm),
      duration: gradual ? Math.max(toNumber(trigger.duration), 0) : 0,
      ms: 0,
    });
  }
  let ms = 0;
  let previous: BpmSegment | null = null;
  for (const segment of segments) {
    ms += previous
      ? msIn(previous, segment.beat)
      : (segment.beat * 60000) / baseBpm;
    segment.ms = ms;
    previous = segment;
  }

  return {
    msAt: (beat) => {
      const i = lastAtOrBefore(segments, "beat", beat);
      if (i < 0) return (beat * 60000) / baseBpm;
      return segments[i].ms + msIn(segments[i], beat);
    },
    beatAt: (ms) => {
      const i = lastAtOrBefore(segments, "ms", ms);
      if (i < 0) return (ms * baseBpm) / 60000;
      return beatIn(segments[i], ms);
    },
  };
};
