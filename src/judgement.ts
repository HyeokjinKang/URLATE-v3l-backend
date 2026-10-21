export interface JudgeCounts {
  perfect: number;
  great: number;
  good: number;
  bad: number;
  miss: number;
  bullet: number;
}

export interface JudgeResult {
  accuracy: number;
  rank: string;
  medal: number;
}

export const evaluateJudges = ({
  perfect,
  great,
  good,
  bad,
  miss,
  bullet,
}: JudgeCounts): JudgeResult => {
  const totalJudge = perfect + great + good + bad + miss + bullet;
  const accuracy = Number(
    (
      ((perfect + (great / 10) * 8 + (good / 10) * 4 + bad / 10) / totalJudge) *
      100
    ).toFixed(1),
  );
  let rank;
  let medal = 1;
  if (accuracy >= 98 && bad == 0 && miss == 0 && bullet == 0) {
    rank = "SS";
  } else if (accuracy >= 95) {
    rank = "S";
  } else if (accuracy >= 90) {
    rank = "A";
  } else if (accuracy >= 80) {
    rank = "B";
  } else if (accuracy >= 70) {
    rank = "C";
  } else {
    rank = "F";
    medal = 0;
  }
  if (bad == 0 && miss == 0 && bullet == 0) {
    medal += 2;
    if (bad == 0 && good == 0 && great == 0 && perfect != 0) {
      medal = 7;
    }
  }
  return { accuracy, rank, medal };
};

export const parseJudgeString = (judge: string): JudgeCounts | null => {
  const parts = String(judge)
    .split("/")
    .map((part) => Number(part.trim()));
  if (
    parts.length !== 6 ||
    !parts.every((n) => Number.isInteger(n) && n >= 0) ||
    parts.every((n) => n === 0)
  ) {
    return null;
  }
  const [perfect, great, good, bad, miss, bullet] = parts;
  return { perfect, great, good, bad, miss, bullet };
};

export const formatJudgeString = (counts: JudgeCounts): string =>
  `${counts.perfect} / ${counts.great} / ${counts.good} / ${counts.bad} / ${counts.miss} / ${counts.bullet}`;
