import signale from "signale";
import { v4 } from "uuid";

import { knex } from "./db";
import { invalidate, invalidateGroup, keys } from "./cache";
import { setRating } from "./rating-index";

/**
 * 기록 저장 계층입니다.
 *
 * 이전에는 /playRecord가 `http://localhost:<port>/record`로 자기 자신을 다시
 * 호출했습니다. 그 결과 (1) 내부 전용 로직이 공개 라우트로 노출되어 secret만
 * 알면 임의 닉네임의 기록·rating을 조작할 수 있었고, (2) /playRecord의 입력
 * 검증을 전혀 거치지 않는 우회 경로가 생겼으며, (3) 요청마다 불필요한 HTTP
 * 왕복과 커넥션 점유가 발생했습니다. 이제 검증을 통과한 값만 이 함수로
 * 직접 전달합니다.
 */
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

const uuid = () => {
  const tokens = v4().split("-");
  return tokens[2] + tokens[1] + tokens[0] + tokens[3] + tokens[4];
};

/**
 * 검증이 끝난 기록을 저장하고 관련 캐시를 정리합니다.
 * 호출자는 반드시 신뢰할 수 있는 값(세션에서 확정된 nickname 등)만 전달해야 합니다.
 */
export const submitRecord = async (submission: RecordSubmission) => {
  // 트랜잭션 커밋 이후에 캐시를 비우기 위해 갱신된 값을 밖으로 꺼냅니다.
  let updatedUserid: string | null = null;
  let updatedRating = 0;

  // read-modify-write 경쟁 조건 방지를 위해 트랜잭션 + 사용자 행 잠금으로 처리합니다.
  await knex.transaction(async (trx) => {
    // 난이도는 클라이언트 값을 신뢰하지 않고 tracks 테이블에서 권위 있는 값을 도출합니다.
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
        // 파싱 실패 시 상한 검증을 거친 클라이언트 값으로 폴백합니다.
      }
    }

    let isBest = 0;
    const result = await trx("trackRecords")
      .select("record", "medal", "index")
      .where("nickname", submission.nickname)
      .where("filename", submission.fileName)
      .where("isBest", 1)
      .where("difficulty", submission.difficultySelection);
    // 양쪽 모두 Number로 맞춰 비교합니다(문자열 컬럼일 때 사전순 비교가 되는 것을 방지).
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
        "1stNum",
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
      clear = 0,
      medal = submission.medal;
    if (isBest) {
      if (result.length) medal = medal - Number(result[0].medal);
      if (medal >= 4) {
        ap = 1;
        medal -= 4;
      }
      if (medal >= 2) {
        fc = 1;
        medal -= 2;
      }
      if (medal >= 1) {
        clear = 1;
      }
      const allRecords = await trx("trackRecords")
        .select("nickname")
        .where("filename", submission.fileName)
        .where("isBest", 1)
        .where("difficulty", submission.difficultySelection)
        .orderBy("record", "desc")
        .limit(1);
      if (allRecords.length && allRecords[0].nickname == submission.nickname)
        isBest = 2;
    }
    updatedUserid = String(user[0].userid);
    updatedRating = Number(user[0].rating) + ratingDiff;
    // recentPlay가 손상되어 있어도 기록 저장이 실패하지 않도록 방어적으로 파싱합니다.
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
        "1stNum": Number(user[0]["1stNum"]) + (isBest == 2 ? 1 : 0),
      });
  });

  // 커밋이 끝난 뒤에만 캐시를 정리합니다. 방금 남긴 기록이 즉시 보여야 하므로
  // TTL 만료를 기다리지 않고 관련 키를 직접 비웁니다.
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
