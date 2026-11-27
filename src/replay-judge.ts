/**
 * Re-judges a replay against the chart the way URLATE public/js/player.js and
 * public/modules/utils.js judge a live play. Keep the two in step.
 */
import { chartTiming, ChartNote, ReplayChart } from "./pattern-chart";
import { rateFactor } from "./pattern-stats";

export interface JudgeEvent {
  seekMs: number;
  kind: string;
  index: number;
  x: number;
  y: number;
  judge: string;
  key: string;
}

export interface JudgeSettings {
  soundOffset: number;
  displayOffset: number;
  canvasWidth: number;
  canvasHeight: number;
}

export type JudgeFailure =
  | "settings"
  | "duplicate"
  | "order"
  | "unjudged"
  | "timing"
  | "direction"
  | "position"
  | "score"
  | "combo";

export interface JudgeResult {
  failure: JudgeFailure | null;
  score: number;
  maxCombo: number;
  timingMismatches: number;
  farPresses: number;
}

const PRESS_WINDOW_FRAMES = 18;
const RELEASE_LATE_FRAMES = 16;
const HOLD_NOTE = 2;
const WHEEL_NOTE = 1;
const SCORE_BASE = 100_000_000;
const END_MARGIN_BEATS = 2;

/** One frame either side: the judged and the logged song time come from separate song.seek() calls. */
const TIMING_SLACK_FRAMES = 1;
const MAX_TIMING_MISMATCHES = 2;
/**
 * The click uses the hit list from the last frame, so the cursor may have moved since.
 * Allowed in note radii of the longer canvas side, on top of the note radius.
 */
const POSITION_SLACK = 1;
const MAX_FAR_PRESSES = 3;
const MAX_FAR_PRESS_RATIO = 0.05;
const SCORE_SLACK_RATIO = 0.002;
const SCORE_SLACK = 2000;
const COMBO_SLACK = 3;
const MAX_SOUND_OFFSET_MS = 5000;

const msToFrames = (ms: number) => (ms * 60) / 1000;

const judgeTiming = (frames: number) => {
  const f = Math.abs(frames);
  if (f <= 3) return "Perfect";
  if (f <= 7) return "Great";
  if (f <= 12) return "Good";
  if (f <= PRESS_WINDOW_FRAMES) return "Bad";
  return "Miss";
};

const judgeReleaseTiming = (frames: number) => {
  if (frames >= -3 && frames <= 5) return "Perfect";
  if (frames >= -8 && frames <= 10) return "Great";
  if (frames >= -14 && frames <= RELEASE_LATE_FRAMES) return "Good";
  if (frames > RELEASE_LATE_FRAMES) return "Bad";
  return "Miss";
};

const judgeWheelTiming = (frames: number) => {
  const f = Math.abs(frames);
  if (f <= 5) return "Perfect";
  if (f <= 12) return "Great";
  if (f <= PRESS_WINDOW_FRAMES) return "Good";
  return "Miss";
};

const holdTickCount = (duration: number) =>
  Math.max(Math.ceil(duration) - 1, 0) + 2;

const fits = (
  judge: (frames: number) => string,
  frames: number[],
  label: string,
) =>
  frames.some(
    (f) =>
      judge(f - TIMING_SLACK_FRAMES) === label ||
      judge(f) === label ||
      judge(f + TIMING_SLACK_FRAMES) === label,
  );

interface Hold {
  note: ChartNote;
  total: number;
  next: number;
}

export const judgeReplay = (
  events: JudgeEvent[],
  chart: ReplayChart,
  settings: JudgeSettings,
  rate: number,
  submitted: { score: number; maxCombo: number },
): JudgeResult => {
  const result: JudgeResult = {
    failure: null,
    score: 0,
    maxCombo: 0,
    timingMismatches: 0,
    farPresses: 0,
  };
  const fail = (failure: JudgeFailure) => ({ ...result, failure });

  const { soundOffset, displayOffset, canvasWidth, canvasHeight } = settings;
  if (
    !(Math.abs(soundOffset) <= MAX_SOUND_OFFSET_MS) ||
    !(Math.abs(displayOffset) <= MAX_SOUND_OFFSET_MS) ||
    !(canvasWidth > 0) ||
    !(canvasHeight > 0)
  ) {
    return fail("settings");
  }

  const timing = chartTiming(chart);
  const beatsAt = (seekMs: number) =>
    Number(
      timing.beatAt(seekMs - (chart.offset + soundOffset)).toPrecision(10),
    );
  const framesFrom = (target: number, beats: number) =>
    msToFrames((timing.msAt(beats) - timing.msAt(target)) / rate);
  /** Frames from `target` as the render loop saw it, which adds the display offset. */
  const framesBoth = (target: number, seekMs: number) => [
    framesFrom(target, beatsAt(seekMs)),
    framesFrom(target, beatsAt(seekMs + displayOffset)),
  ];

  const basic = SCORE_BASE / chart.notes;
  const factor = rateFactor(rate);
  let combo = 0;
  const addScore = (judge: string, weight = 1) => {
    if (judge === "Miss") {
      combo = 0;
      return;
    }
    combo++;
    result.maxCombo = Math.max(result.maxCombo, combo);
    const base = basic * weight;
    if (judge === "Perfect")
      result.score += Math.round((base + combo * 5) * factor);
    else if (judge === "Great")
      result.score += Math.round((base * 0.8 + combo * 5) * factor);
    else if (judge === "Good")
      result.score += Math.round((base * 0.4 + combo * 3) * factor);
    else {
      combo = 0;
      result.score += Math.round(base * 0.1 * factor);
    }
  };

  const holds = new Map<number, Hold>();
  const advanceTicks = (hold: Hold, beats: number) => {
    while (hold.next < hold.total - 1 && hold.note[0] + hold.next <= beats) {
      hold.next++;
      addScore("Perfect", 2 / hold.total);
    }
  };
  const advanceAllTicks = (seekMs: number) => {
    const beats = beatsAt(seekMs + displayOffset);
    for (const hold of holds.values()) advanceTicks(hold, beats);
  };

  const state = new Array<"pressed" | "done" | undefined>(chart.notes);
  let presses = 0;

  for (const event of events) {
    const note = chart.noteData[event.index];
    switch (event.kind) {
      case "press": {
        if (state[event.index]) return fail("duplicate");
        advanceAllTicks(event.seekMs);
        const [beat, value, x, y, duration, direction] = note;
        const beats = beatsAt(event.seekMs);
        const judge = value === WHEEL_NOTE ? judgeWheelTiming : judgeTiming;
        if (!fits(judge, [framesFrom(beat, beats)], event.judge))
          result.timingMismatches++;
        if (value === WHEEL_NOTE) {
          if (event.key !== (direction === 1 ? "↑" : "↓"))
            return fail("direction");
        }
        const dx = ((event.x - x) * canvasWidth) / 200;
        const dy = ((event.y - y) * canvasHeight) / 200;
        const radius =
          canvasWidth / 40 +
          (Math.max(canvasWidth, canvasHeight) / 40) * POSITION_SLACK;
        if (!(dx * dx + dy * dy <= radius * radius)) result.farPresses++;
        presses++;
        if (value === HOLD_NOTE) {
          const hold: Hold = { note, total: holdTickCount(duration), next: 1 };
          while (hold.next < hold.total - 1 && beat + hold.next <= beats)
            hold.next++;
          holds.set(event.index, hold);
          state[event.index] = "pressed";
          addScore(event.judge, 2 / hold.total);
        } else {
          state[event.index] = "done";
          addScore(event.judge);
        }
        break;
      }
      case "release": {
        const hold = holds.get(event.index);
        if (!hold || state[event.index] !== "pressed") return fail("order");
        advanceAllTicks(event.seekMs);
        advanceTicks(hold, beatsAt(event.seekMs));
        const [beat, , , , duration] = note;
        if (
          !fits(
            judgeReleaseTiming,
            framesBoth(beat + duration, event.seekMs),
            event.judge,
          )
        )
          result.timingMismatches++;
        holds.delete(event.index);
        state[event.index] = "done";
        addScore(event.judge, 2 / hold.total);
        break;
      }
      case "miss":
        if (state[event.index]) return fail("duplicate");
        advanceAllTicks(event.seekMs);
        state[event.index] = "done";
        addScore("Miss");
        break;
      case "bullet":
        advanceAllTicks(event.seekMs);
        combo = 0;
        break;
    }
  }
  const lastSeek = events.length ? events[events.length - 1].seekMs : 0;
  advanceAllTicks(chart.endMs ?? lastSeek);

  const cutoff =
    chart.endBeat === null ? Infinity : chart.endBeat - END_MARGIN_BEATS;
  for (let i = 0; i < chart.notes; i++) {
    const [beat, value, , , duration] = chart.noteData[i];
    if (beat < cutoff && !state[i]) return fail("unjudged");
    if (
      value === HOLD_NOTE &&
      state[i] === "pressed" &&
      beat + duration < cutoff
    )
      return fail("unjudged");
  }

  if (result.timingMismatches > MAX_TIMING_MISMATCHES) return fail("timing");
  if (
    result.farPresses > MAX_FAR_PRESSES &&
    result.farPresses > presses * MAX_FAR_PRESS_RATIO
  )
    return fail("position");
  if (
    Math.abs(result.score - submitted.score) >
    result.score * SCORE_SLACK_RATIO + SCORE_SLACK
  )
    return fail("score");
  if (Math.abs(result.maxCombo - submitted.maxCombo) > COMBO_SLACK)
    return fail("combo");
  return result;
};
