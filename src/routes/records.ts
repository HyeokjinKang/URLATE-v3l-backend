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

// 한 판이 아무리 짧아도 분당 수십 판은 나올 수 없습니다. 기록 제출은 DB 쓰기와
// 리플레이 파일 생성을 동반하므로, 전역 한도(600/분)만으로는 로그인한 사용자
// 한 명이 디스크와 DB를 밀어붙일 수 있습니다.
const playRecordLimiter = rateLimit({
  windowSec: 60,
  max: 30,
  prefix: "playrecord",
});

router.put("/playRecord", playRecordLimiter, requireLogin, async (req, res) => {
  //doesn't scan the entire record yet
  //userid, username, rank, score, maxCombo, perfect, great, good, bad, miss, bullet, accuracy, record

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

  // 신원은 세션에서 확정된 값만 씁니다. 클라이언트가 보낸 userid/username은 무시합니다.
  const nickname: string = results[0].nickname;

  // 파일 경로와 DB 조회에 쓰이므로 형식을 제한합니다.
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

  // 판정 카운트·점수·콤보는 유한한 비음수 정수만 허용합니다.
  const perfect = toFiniteNonNegInt(req.body.perfect);
  const great = toFiniteNonNegInt(req.body.great);
  const good = toFiniteNonNegInt(req.body.good);
  const bad = toFiniteNonNegInt(req.body.bad);
  const miss = toFiniteNonNegInt(req.body.miss);
  const bullet = toFiniteNonNegInt(req.body.bullet);
  const score = toFiniteNonNegInt(req.body.score);
  const maxCombo = toFiniteNonNegInt(req.body.maxCombo);
  // 캐시 그룹 키에도 쓰이므로 범위를 고정합니다.
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
  // 서버가 재계산한 rank/accuracy와 클라이언트 주장을 대조합니다.
  // score 자체는 여전히 클라이언트 계산값입니다. 완전한 치팅 방지에는 서버측
  // 리플레이 재생 검증이 필요합니다.
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
    // 검증이 끝난 값만 넘깁니다.
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
  // isBest/rating은 이후 플레이로 바뀌므로 짧은 TTL만 적용하고 무효화는 하지 않습니다.
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

// 곡 선택 화면이 트랙 수만큼 호출하던 것을 요청 한 번으로 대체합니다.
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
      // /record/:filename/:nickname과 동일하게 난이도 내림차순입니다.
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

// recentPlay의 id마다 /record/:index를 호출하던 것을 요청 한 번으로 대체합니다.
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
    // whereIn이 흐트러뜨린 순서를 recentPlay의 최신순으로 되돌립니다.
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

// 공개 프로필은 닉네임으로 조회합니다(/profile/nickname/:nickname과 같은 이유).
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
  // 곡 선택 화면은 /trackRecords/:nickname을 쓰지만 기존 클라이언트를 위해 유지합니다.
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
  // 빈 결과까지 캐싱하는 경로이므로 실재 여부를 먼저 확인합니다.
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
    // 미플레이 곡의 빈 결과도 캐싱합니다. 곡 선택 화면에서는 이쪽이 다수입니다.
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
      // 응답은 10건만 쓰므로 DB에서부터 잘라 옵니다.
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
    // 캐시 키를 이루는 파라미터이므로 형식을 고정합니다.
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

    // 같은 곡·난이도의 기록이 갱신되면 함께 비워야 하므로 한 그룹으로 묶습니다.
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

    // 자신보다 앞선 인원 수로 순위를 계산합니다. 기록이 없으면 null을 돌려
    // 캐시에 남기지 않습니다(없는 닉네임으로 키가 늘어나는 것을 막습니다).
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
    // 기록이 없을 때의 응답값 0은 기존 클라이언트와 동일하게 유지합니다.
    res.status(200).json({ result: "success", results, rank: rank ?? 0 });
  },
);
