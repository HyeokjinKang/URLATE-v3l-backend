import signale from "signale";
import { v4 } from "uuid";

import { knex } from "./db";
import { invalidate, invalidateGroup, keys } from "./cache";
import { setRating } from "./rating-index";

// 기록 저장 계층입니다. 검증을 마친 값만 전달해야 합니다.
export interface RecordSubmission {
  fileName: string;
  nickname: string;
  rank: string;
  record: number;
  maxcombo: number;
  medal: number;
  difficultySelection: number;
  difficulty: number;
  judge: string;
  accuracy: number;
}

/**
 * 현재 1위인 곡(난이도별) 수를 셉니다.
 *
 * 컬럼에 누적하지 않고 조회 때마다 세는 이유는, 1위를 빼앗긴 쪽의 값도 줄어야
 * 하는데 카운터 방식으로는 기록 저장 트랜잭션에서 남의 행까지 잠가야 하기
 * 때문입니다. 동점자는 양쪽 모두 1위로 셉니다(순위표 rank 계산과 같은 기준).
 *
 * (filename, difficulty, isBest, record) 인덱스가 필요합니다. schema/indexes.sql 참고.
 */
export const countFirstPlaces = async (nickname: string): Promise<number> => {
  const [row] = await knex({ mine: "trackRecords" })
    .where("mine.nickname", nickname)
    .where("mine.isBest", 1)
    .whereNotExists((builder) =>
      builder
        .select(knex.raw("1"))
        .from({ other: "trackRecords" })
        .where("other.isBest", 1)
        .whereRaw("other.filename = mine.filename")
        .whereRaw("other.difficulty = mine.difficulty")
        .whereRaw("other.record > mine.record"),
    )
    .count({ count: "*" });
  return Number(row.count);
};

// medal 비트필드입니다. AP는 FC를, FC는 CLEAR를 포함합니다(7=AP, 3=FC, 1=CLEAR).
const MEDAL_CLEAR = 1;
const MEDAL_FC = 2;
const MEDAL_AP = 4;

const uuid = () => {
  const tokens = v4().split("-");
  return tokens[2] + tokens[1] + tokens[0] + tokens[3] + tokens[4];
};

// 기록을 저장하고 관련 캐시를 정리합니다. nickname은 세션에서 확정된 값이어야 합니다.
export const submitRecord = async (submission: RecordSubmission) => {
  // 커밋 이후에 캐시를 비우기 위해 갱신된 값을 밖으로 꺼냅니다.
  let updatedUserid: string | null = null;
  let updatedRating = 0;

  // read-modify-write 경쟁을 막기 위해 트랜잭션 + 행 잠금으로 처리합니다.
  await knex.transaction(async (trx) => {
    // 난이도는 클라이언트 값 대신 tracks 테이블에서 도출합니다.
    let difficultyValue = submission.difficulty;
    const trackRow = await trx("tracks")
      .select("difficulty")
      .where("fileName", submission.fileName)
      .first();
    if (trackRow) {
      try {
        const arr = JSON.parse(trackRow.difficulty);
        const idx = submission.difficultySelection - 1;
        if (
          Array.isArray(arr) &&
          idx >= 0 &&
          idx < arr.length &&
          Number.isFinite(Number(arr[idx]))
        ) {
          difficultyValue = Number(arr[idx]);
        }
      } catch {
        // 파싱 실패 시 상한 검증을 거친 클라이언트 값을 씁니다.
      }
    }

    let isBest = 0;
    const result = await trx("trackRecords")
      .select("record", "medal", "index")
      .where("nickname", submission.nickname)
      .where("filename", submission.fileName)
      .where("isBest", 1)
      .where("difficulty", submission.difficultySelection);
    // 문자열 컬럼일 때 사전순 비교가 되지 않도록 Number로 맞춥니다.
    if (result.length && Number(result[0].record) < submission.record) {
      isBest = 1;
      await trx("trackRecords")
        .update({
          isBest: 0,
        })
        .where("index", result[0].index);
    }
    if (!result.length) isBest = 1;
    const index = uuid();
    let rating = Number(
      Math.round(
        (submission.record / 100000000) * submission.accuracy * difficultyValue,
      ),
    );
    let ratingDiff = rating;
    const ratingBest = await trx("trackRecords")
      .select("rating", "index")
      .where("nickname", submission.nickname)
      .where("filename", submission.fileName)
      .where("difficulty", submission.difficultySelection)
      .orderBy("rating", "desc")
      .limit(1);
    if (ratingBest.length) {
      if (Number(ratingBest[0].rating) > rating) rating = 0;
      else {
        await trx("trackRecords")
          .update({
            rating: 0,
          })
          .where("index", ratingBest[0].index);
        ratingDiff = rating - Number(ratingBest[0].rating);
      }
    }
    await trx("trackRecords").insert({
      filename: submission.fileName,
      nickname: submission.nickname,
      rank: submission.rank,
      record: submission.record,
      maxcombo: submission.maxcombo,
      medal: submission.medal,
      difficulty: submission.difficultySelection,
      date: new Date(),
      isBest,
      index,
      judge: submission.judge,
      accuracy: submission.accuracy,
      rating,
    });
    const user = await trx("users")
      .where("nickname", submission.nickname)
      .select(
        "userid",
        "rating",
        "scoreSum",
        "accuracy",
        "recentPlay",
        "playtime",
        "ap",
        "fc",
        "clear",
      )
      .forUpdate();
    if (!user.length) {
      throw new Error("User not found for record update.");
    }
    let ap = 0,
      fc = 0,
      clear = 0;
    if (isBest) {
      // 비트별로 비교해야 합니다. 산술 뺄셈으로는 점수가 오르면서 콤보가
      // 끊긴 경우(뱃지 감소)에 차분이 음수가 되어 반영되지 않습니다.
      const newMedal = submission.medal;
      const oldMedal = result.length ? Number(result[0].medal) : 0;
      const diff = (mask: number) =>
        (newMedal & mask ? 1 : 0) - (oldMedal & mask ? 1 : 0);
      ap = diff(MEDAL_AP);
      fc = diff(MEDAL_FC);
      clear = diff(MEDAL_CLEAR);
    }
    // 1위 곡 수는 여기서 세지 않습니다. countFirstPlaces가 조회 때 계산합니다.
    updatedUserid = String(user[0].userid);
    updatedRating = Number(user[0].rating) + ratingDiff;
    // recentPlay가 손상되어도 기록 저장은 실패하지 않아야 합니다.
    let recentPlay: unknown;
    try {
      recentPlay = JSON.parse(user[0].recentPlay);
    } catch {
      recentPlay = [];
    }
    await trx("users")
      .where("nickname", submission.nickname)
      .update({
        rating: updatedRating,
        scoreSum: Number(user[0].scoreSum) + submission.record,
        accuracy: (
          Math.round(
            ((Number(user[0].accuracy) * Number(user[0].playtime) +
              submission.accuracy) *
              100) /
              (Number(user[0].playtime) + 1),
          ) / 100
        ).toFixed(2),
        recentPlay: JSON.stringify(
          [index, ...(Array.isArray(recentPlay) ? recentPlay : [])].slice(0, 10),
        ),
        playtime: Number(user[0].playtime) + 1,
        ap: Number(user[0].ap) + ap,
        fc: Number(user[0].fc) + fc,
        clear: Number(user[0].clear) + clear,
      });
  });

  // 방금 남긴 기록이 즉시 보이도록, 커밋 이후에 관련 키를 직접 비웁니다.
  try {
    await invalidate(
      keys.bestRecord(submission.nickname, submission.fileName),
      keys.bestRecords(submission.nickname),
      keys.trackRecords(submission.nickname),
      keys.ranking("asc"),
      keys.ranking("desc"),
      updatedUserid ? keys.profile(updatedUserid) : null,
      updatedUserid ? keys.recentPlays(updatedUserid) : null,
    );
    await invalidateGroup(
      keys.leaderboardGroup(
        submission.fileName,
        submission.difficultySelection,
      ),
    );
    if (updatedUserid) await setRating(updatedUserid, updatedRating);
  } catch (e) {
    // 캐시 정리 실패가 기록 저장 성공을 뒤집지는 않습니다.
    signale.error(e);
  }
};
