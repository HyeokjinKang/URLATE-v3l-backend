import express from "express";
import signale from "signale";

import { observer } from "../achievements";
import { createSuccessResponse, createErrorResponse } from "../api-response";
import { getOrSet, keys } from "../cache";
import { knex } from "../db";
import { rateLimit } from "../middleware/rate-limit";
import { requireLogin } from "../middleware/require-login";
import { submitRecord } from "../record";
import { writeReplayLog } from "../replay-log";
import { notFound } from "../respond";
import { nicknameExists, trackExists, useridOf } from "../services/tracks";
import {
  isValidFileName,
  isValidNickname,
  isValidRecordIndex,
  parseJson,
  toDifficultySelection,
  toFiniteNonNegInt,
  MAX_SCORE,
  SORT_DIRECTIONS,
  TRACK_ORDER_COLUMNS,
} from "../validate";

export const router = express.Router();

const playRecordLimiter = rateLimit({
  windowSec: 60,
  max: 30,
  prefix: "playrecord",
});

router.put("/playRecord", playRecordLimiter, requireLogin, async (req, res) => {
  const results = await knex("users")
    .select("nickname", "userid")
    .where("userid", req.session.userid);
  if (!results.length) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Failed to Load",
          "Failed to load data. Use /auth/status to check your status.",
        ),
      );
    return;
  }

  // Identity comes only from the session; the userid/username the client sent are ignored.
  const nickname: string = results[0].nickname;

  const fileName = req.body.fileName;
  if (!isValidFileName(fileName) || !isValidNickname(nickname)) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Wrong Format",
          "Invalid track or user name.",
        ),
      );
    return;
  }

  const perfect = toFiniteNonNegInt(req.body.perfect);
  const great = toFiniteNonNegInt(req.body.great);
  const good = toFiniteNonNegInt(req.body.good);
  const bad = toFiniteNonNegInt(req.body.bad);
  const miss = toFiniteNonNegInt(req.body.miss);
  const bullet = toFiniteNonNegInt(req.body.bullet);
  const score = toFiniteNonNegInt(req.body.score);
  const maxCombo = toFiniteNonNegInt(req.body.maxCombo);
  const difficultySelection = toDifficultySelection(
    req.body.difficultySelection,
  );
  const difficulty = Number(req.body.difficulty);
  if (
    perfect === null ||
    great === null ||
    good === null ||
    bad === null ||
    miss === null ||
    bullet === null ||
    score === null ||
    maxCombo === null ||
    difficultySelection === null ||
    !Number.isFinite(difficulty) ||
    difficulty < 0
  ) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Wrong Format",
          "Invalid numeric values in submitted record.",
        ),
      );
    return;
  }

  const totalJudge = perfect + great + good + bad + miss + bullet;
  if (totalJudge === 0 || score > MAX_SCORE) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Wrong Format",
          "Submitted record is out of valid range.",
        ),
      );
    return;
  }

  const accuracy = Number(
    (
      ((perfect + (great / 10) * 7 + good / 2 + (bad / 10) * 3) / totalJudge) *
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
  // Cross-checks server-recomputed rank/accuracy against the client's claim. The
  // score itself is still client-computed; stopping that needs replay verification.
  if (rank != req.body.rank || accuracy != Number(req.body.accuracy)) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Failed to Verify",
          "Failed to verify submitted data.",
        ),
      );
    return;
  }

  if (!writeReplayLog(nickname, fileName, req.body.record)) {
    res
      .status(400)
      .json(createErrorResponse("failed", "Wrong Format", "Invalid log path."));
    return;
  }

  observer(`${req.session.userid}`, "JUDGE", {
    perfect,
    great,
    good,
    bad,
    miss,
    bullet,
    accuracy,
    rank,
    medal,
  });
  try {
    await submitRecord({
      fileName,
      nickname,
      rank,
      record: score,
      maxcombo: maxCombo,
      medal,
      difficultySelection,
      difficulty,
      judge: `${perfect} / ${great} / ${good} / ${bad} / ${miss} / ${bullet}`,
      accuracy,
    });
    res.status(200).json(createSuccessResponse("success"));
  } catch (e) {
    signale.error(e);
    res
      .status(500)
      .json(
        createErrorResponse(
          "failed",
          "Failed to Update",
          "Failed to update score.",
        ),
      );
  }
});

router.get("/record/:index", async (req, res) => {
  const index = req.params.index;
  if (!isValidRecordIndex(index)) {
    res
      .status(400)
      .json(
        createErrorResponse("failed", "Wrong Format", "Invalid record index."),
      );
    return;
  }
  const results = await getOrSet(
    "record",
    keys.record(index),
    () =>
      knex("trackRecords")
        .select(
          "filename",
          "rank",
          "record",
          "maxcombo",
          "medal",
          "difficulty",
          "date",
          "judge",
          "isBest",
          "accuracy",
          "rating",
        )
        .where("index", index),
    { cacheEmpty: false },
  );
  if (!results.length) {
    res.status(200).json(createSuccessResponse("empty"));
    return;
  }
  res.status(200).json({ result: "success", results });
});

router.get("/trackRecords/:nickname", async (req, res) => {
  const nickname = req.params.nickname;
  if (!isValidNickname(nickname)) {
    res
      .status(400)
      .json(createErrorResponse("failed", "Wrong Format", "Invalid nickname."));
    return;
  }
  if (!(await nicknameExists(nickname))) {
    notFound(res, "Cannot find user.");
    return;
  }
  const records = await getOrSet(
    "bestRecord",
    keys.trackRecords(nickname),
    async () => {
      const rows = await knex("trackRecords")
        .select(
          "filename",
          "rank",
          "record",
          "maxcombo",
          "medal",
          "difficulty",
          "date",
        )
        .where("nickname", nickname)
        .where("isBest", 1)
        .orderBy("filename", "asc")
        .orderBy("difficulty", "desc");
      const grouped: Record<string, Record<string, unknown>[]> = {};
      for (const row of rows) {
        if (!grouped[row.filename]) grouped[row.filename] = [];
        grouped[row.filename].push({
          rank: row.rank,
          record: row.record,
          maxcombo: row.maxcombo,
          medal: row.medal,
          difficulty: row.difficulty,
          date: row.date,
        });
      }
      return grouped;
    },
  );
  res.status(200).json({ result: "success", records });
});

const loadRecentPlays = (uid: string) =>
  getOrSet("record", keys.recentPlays(uid), async () => {
    const users = await knex("users").select("recentPlay").where("userid", uid);
    if (!users.length) return null;
    const parsed = parseJson(users[0].recentPlay);
    const indexes = Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string").slice(0, 10)
      : [];
    if (!indexes.length) return [];
    const rows = await knex("trackRecords")
      .select(
        "index",
        "filename",
        "rank",
        "record",
        "maxcombo",
        "medal",
        "difficulty",
        "date",
        "judge",
        "isBest",
        "accuracy",
        "rating",
      )
      .whereIn("index", indexes);
    // whereIn doesn't preserve order, so restore recentPlay's most-recent-first order.
    const byIndex = new Map(rows.map((row) => [row.index, row]));
    return indexes
      .map((index) => byIndex.get(index))
      .filter((row) => row !== undefined);
  });

const respondRecentPlays = (
  res: express.Response,
  results: Awaited<ReturnType<typeof loadRecentPlays>>,
) => {
  if (results === null) {
    res
      .status(400)
      .json(
        createErrorResponse("failed", "Failed to Load", "Cannot find user."),
      );
    return;
  }
  res.status(200).json({ result: "success", results });
};

router.get("/recentPlays/nickname/:nickname", async (req, res) => {
  const nickname = req.params.nickname;
  if (!isValidNickname(nickname)) {
    res
      .status(400)
      .json(createErrorResponse("failed", "Wrong Format", "Invalid nickname."));
    return;
  }
  const uid = await useridOf(nickname);
  if (!uid) {
    res
      .status(400)
      .json(
        createErrorResponse("failed", "Failed to Load", "Cannot find user."),
      );
    return;
  }
  respondRecentPlays(res, await loadRecentPlays(uid));
});

router.get("/recentPlays/:uid", async (req, res) => {
  respondRecentPlays(res, await loadRecentPlays(req.params.uid));
});

router.get("/record/:filename/:nickname", async (req, res) => {
  // The track-select screen uses /trackRecords/:nickname now; kept for older clients.
  const { filename, nickname } = req.params;
  if (!isValidFileName(filename) || !isValidNickname(nickname)) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Wrong Format",
          "Invalid track or user name.",
        ),
      );
    return;
  }
  // This path caches even an empty result, so check existence first.
  if (!(await trackExists(filename)) || !(await nicknameExists(nickname))) {
    notFound(res, "Cannot find track or user.");
    return;
  }
  const results = await getOrSet(
    "bestRecord",
    keys.bestRecord(nickname, filename),
    () =>
      knex("trackRecords")
        .select("rank", "record", "maxcombo", "medal", "difficulty", "date")
        .where("nickname", nickname)
        .where("filename", filename)
        .where("isBest", 1)
        .orderBy("difficulty", "DESC"),
  );
  if (!results.length) {
    res.status(200).json(createSuccessResponse("empty"));
    return;
  }
  res.status(200).json({ result: "success", results });
});

router.get("/bestRecords/:nickname", async (req, res) => {
  const nickname = req.params.nickname;
  if (!isValidNickname(nickname)) {
    res
      .status(400)
      .json(createErrorResponse("failed", "Wrong Format", "Invalid nickname."));
    return;
  }
  if (!(await nicknameExists(nickname))) {
    notFound(res, "Cannot find user.");
    return;
  }
  const results = await getOrSet("bestRecord", keys.bestRecords(nickname), () =>
    knex("trackRecords")
      .select(
        "filename",
        "rank",
        "record",
        "maxcombo",
        "medal",
        "difficulty",
        "date",
        "judge",
        "isBest",
        "accuracy",
        "rating",
      )
      .where("nickname", nickname)
      .whereNot("rating", 0)
      .orderBy("difficulty", "desc")
      .orderBy("rating", "desc")
      .limit(10),
  );
  res.status(200).json({ result: "success", results });
});

router.get(
  "/records/:fileName/:difficulty/:order/:sort/:nickname",
  async (req, res) => {
    const order = req.params.order;
    const sort = (req.params.sort || "").toLowerCase();

    if (!TRACK_ORDER_COLUMNS.has(order) || !SORT_DIRECTIONS.has(sort)) {
      res
        .status(400)
        .json(
          createErrorResponse(
            "failed",
            "Wrong Format",
            "Invalid order or sort parameter.",
          ),
        );
      return;
    }

    const { fileName, nickname } = req.params;
    const difficulty = toDifficultySelection(req.params.difficulty);
    if (
      difficulty === null ||
      !isValidFileName(fileName) ||
      !isValidNickname(nickname)
    ) {
      res
        .status(400)
        .json(
          createErrorResponse(
            "failed",
            "Wrong Format",
            "Invalid track, difficulty or user name.",
          ),
        );
      return;
    }
    if (!(await trackExists(fileName))) {
      notFound(res, "Cannot find track.");
      return;
    }

    const group = keys.leaderboardGroup(fileName, difficulty);

    const results = await getOrSet(
      "leaderboard",
      keys.leaderboard(fileName, difficulty, order, sort),
      () =>
        knex("trackRecords")
          .select("rank", "record", "maxcombo", "nickname")
          .where("filename", fileName)
          .where("difficulty", difficulty)
          .where("isBest", 1)
          .orderBy(order, sort)
          .limit(100),
      { group },
    );

    const rank = await getOrSet(
      "leaderboard",
      keys.leaderboardRank(fileName, difficulty, order, sort, nickname),
      async (): Promise<number | null> => {
        const self = await knex("trackRecords")
          .select(order)
          .where("filename", fileName)
          .where("difficulty", difficulty)
          .where("isBest", 1)
          .where("nickname", nickname)
          .first();
        if (!self) return null;
        const op = sort === "desc" ? ">" : "<";
        const [{ better }] = await knex("trackRecords")
          .where("filename", fileName)
          .where("difficulty", difficulty)
          .where("isBest", 1)
          .where(order, op, self[order])
          .count({ better: "*" });
        return Number(better) + 1;
      },
      { group },
    );
    // 0 for a missing record, matching the response older clients expect.
    res.status(200).json({ result: "success", results, rank: rank ?? 0 });
  },
);
