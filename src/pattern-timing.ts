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

/** Song time in ms (before the pattern offset) at which `beat` is reached. */
export const createMsAt = (pattern: Record<string, unknown>) => {
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

  return (beat: number) => {
    let i = -1;
    for (let k = 0; k < segments.length && segments[k].beat <= beat; k++) i = k;
    if (i < 0) return (beat * 60000) / baseBpm;
    return segments[i].ms + msIn(segments[i], beat);
  };
};
