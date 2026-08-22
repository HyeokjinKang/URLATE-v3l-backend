import signale from "signale";
import { v4 } from "uuid";

import { knex } from "./db";
import { invalidate, invalidateGroup, keys } from "./cache";
import { setRating } from "./rating-index";

// Record persistence layer. Only pass in values that have already been validated.
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
 * Counts how many tracks (per difficulty) this user currently holds first
 * place on.
 *
 * Computed on each lookup rather than kept in a column, because a counter
 * would also need to decrement whoever just got knocked out of first --
 * which means locking someone else's row inside the record-submission
 * transaction. Ties count as first place for both sides, matching how the
 * leaderboard's rank is calculated.
 *
 * Needs the (filename, difficulty, isBest, record) index; see schema/indexes.sql.
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

// medal bitfield: AP implies FC, FC implies CLEAR (7=AP, 3=FC, 1=CLEAR).
const MEDAL_CLEAR = 1;
const MEDAL_FC = 2;
const MEDAL_AP = 4;

const uuid = () => {
  const tokens = v4().split("-");
  return tokens[2] + tokens[1] + tokens[0] + tokens[3] + tokens[4];
};

// Saves a record and invalidates the related caches. nickname must be the
// value already resolved from the session.
export const submitRecord = async (submission: RecordSubmission) => {
  // Pulled out of the transaction so the cache can be cleared after commit.
  let updatedUserid: string | null = null;
  let updatedRating = 0;

  // Transaction + row lock to prevent a read-modify-write race.
  await knex.transaction(async (trx) => {
    // Serializes record submissions for this user. Must be acquired before
    // the trackRecords read-modify-write below (isBest / rating handoff).
    // Acquiring it later would let two concurrent submissions both read the
    // same "previous best" and both end up isBest=1, double-counting the
    // leaderboard and the first-place count.
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

    // Derive difficulty from the tracks table instead of trusting the client value.
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
        // On parse failure, fall back to the client value (already range-checked).
      }
    }

    let isBest = 0;
    const result = await trx("trackRecords")
      .select("record", "medal", "index")
      .where("nickname", submission.nickname)
      .where("filename", submission.fileName)
      .where("isBest", 1)
      .where("difficulty", submission.difficultySelection);
    // Cast to Number so a string column doesn't get compared lexicographically.
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
    let ap = 0,
      fc = 0,
      clear = 0;
    if (isBest) {
      // Must compare per-bit. A plain arithmetic subtraction would go negative
      // (and get dropped) when the score improves but the combo badge drops.
      const newMedal = submission.medal;
      const oldMedal = result.length ? Number(result[0].medal) : 0;
      const diff = (mask: number) =>
        (newMedal & mask ? 1 : 0) - (oldMedal & mask ? 1 : 0);
      ap = diff(MEDAL_AP);
      fc = diff(MEDAL_FC);
      clear = diff(MEDAL_CLEAR);
    }
    // First-place count isn't tracked here; countFirstPlaces computes it on read.
    updatedUserid = String(user[0].userid);
    updatedRating = Number(user[0].rating) + ratingDiff;
    // A corrupted recentPlay shouldn't fail the record submission.
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
          [index, ...(Array.isArray(recentPlay) ? recentPlay : [])].slice(
            0,
            10,
          ),
        ),
        playtime: Number(user[0].playtime) + 1,
        ap: Number(user[0].ap) + ap,
        fc: Number(user[0].fc) + fc,
        clear: Number(user[0].clear) + clear,
      });
  });

  // Clear the related keys right after commit so the new record shows up immediately.
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
    // A cache cleanup failure shouldn't undo a successful record submission.
    signale.error(e);
  }
};
