import cookieParser from "cookie-parser";
import express from "express";
import session from "express-session";
import { createClient } from "redis";
import { RedisStore } from "connect-redis";
import signale from "signale";
import fetch from "node-fetch";
import { v4 } from "uuid";
import schedule from "node-schedule";
import fs from "fs-extra";
import path from "path";
import { OAuth2Client } from "google-auth-library";
import Knex from "knex";

import { URLATEConfig, SimpleResponse } from "./types/config.schema";
import {
  createSuccessResponse,
  createErrorResponse,
  createStatusResponse,
} from "./api-response";
import { observer } from "./achievements";

import settingsConfig from "../config/settings.json";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const config: URLATEConfig = require(__dirname + "/../config/config.json");

const gidClient = new OAuth2Client(config.google.clientId);

const app = express();
app.locals.pretty = true;

const redisClient = createClient({
  socket: {
    host: config.redis.host,
    port: config.redis.port,
  },
  username: config.redis.username,
  password: config.redis.password,
});

const redisStore = new RedisStore({
  client: redisClient,
  prefix: "urlate:",
});

const knex = Knex({
  client: "mysql",
  connection: {
    host: config.database.host,
    user: config.database.user,
    password: config.database.password,
    database: config.database.db,
  },
  pool: { min: 0, max: 7 },
});

const sessionMiddleware = session({
  store: redisStore,
  resave: config.session.resave,
  saveUninitialized: config.session.saveUninitialized,
  secret: config.session.secret,
  name: "urlate",
  cookie: {
    domain: config.session.domain,
  },
});

app.use(sessionMiddleware);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

redisClient.on("connect", () => {
  signale.success("Connected to redis server.");
});

redisClient.on("error", (err) => {
  signale.error(err);
});

const gidVerify = async (token: string, clientId: string) => {
  const ticket = await gidClient.verifyIdToken({
    idToken: token,
    audience: clientId,
  });
  return ticket.getPayload();
};

const uuid = () => {
  const tokens = v4().split("-");
  return tokens[2] + tokens[1] + tokens[0] + tokens[3] + tokens[4];
};

// 파일 경로 세그먼트로 안전한 문자열인지 검증합니다(경로 조작 방지).
const isSafeSegment = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);

// 유한한 비음수 정수만 허용합니다(치팅용 이상치 방지).
const toFiniteNonNegInt = (value: unknown): number | null => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
};

// 판정 점수 이론적 상한(정합성 검증용). 실제 최고 기록보다 충분히 큰 값입니다.
const MAX_SCORE = 100_000_000;

// 파일 경로 세그먼트로 안전한

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const updateRankHistory = schedule.scheduleJob("59 23 * * *", async () => {
  signale.info(new Date());
  signale.pending(`Updating rank history...`);
  const users = await knex("users")
    .select("userid", "rankHistory")
    .orderBy("rating", "desc");
  for (let i = 0; i < users.length; i++) {
    const history = [...JSON.parse(users[i].rankHistory), i + 1];
    await knex("users")
      .update({ rankHistory: JSON.stringify(history.slice(-19)) })
      .where("userid", users[i].userid);
    let rank100 = false,
      rank50 = false,
      rank10 = false,
      rank1 = false;
    if (i < 100) {
      rank100 = true;
      if (i < 50) {
        rank50 = true;
        if (i < 10) {
          rank10 = true;
          if (i < 1) {
            rank1 = true;
          }
        }
      }
    }
    observer(`${users[i].userid}`, "RANK", {
      rank100,
      rank50,
      rank10,
      rank1,
    });
  }
  signale.info(new Date());
  signale.success(`Rank history updated.`);
});

app.get("/auth/status", async (req, res) => {
  if (!req.session.userid) {
    res.status(200).json(createStatusResponse("Not logined"));
    return;
  }

  const results = await knex("users")
    .select("userid", "nickname")
    .where("userid", req.session.userid);
  if (!results[0]) {
    res
      .status(200)
      .json({ status: "Not registered", tempName: req.session.tempName });
    return;
  }

  res.status(200).json(createStatusResponse("Logined"));
});

app.post("/auth/login", async (req, res) => {
  try {
    if (!req.body.jwt || typeof req.body.jwt.credential !== "string") {
      res
        .status(400)
        .json(
          createErrorResponse(
            "failed",
            "Wrong Request",
            "Missing credential.",
          ),
        );
      return;
    }
    // audience는 서버 설정값으로 고정합니다. 클라이언트가 보낸 clientId는 신뢰하지 않습니다.
    const payload = await gidVerify(
      req.body.jwt.credential,
      config.google.clientId,
    );
    if (payload) {
      // 세션 고정(Session Fixation) 방지: 인증 성공 시 세션 ID를 재발급합니다.
      req.session.regenerate((regenErr) => {
        if (regenErr) {
          signale.error(regenErr);
          res
            .status(500)
            .json(
              createErrorResponse(
                "failed",
                "Session error",
                "Failed to establish session.",
              ),
            );
          return;
        }
        req.session.userid = payload.sub;
        req.session.email = payload.email;
        req.session.picture = payload.picture;
        req.session.tempName = payload.name || payload.given_name || "Name";
        req.session.save(() => {
          signale.debug(new Date());
          signale.debug(`User logined : ${payload.sub}`);
          res.status(200).json(createSuccessResponse("success"));
        });
      });
      return;
    }
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Unexpected response",
          "Unexpected response recieved.",
        ),
      );
  } catch (err) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Verification failed",
          "JWT Verification failed. Did you modify the JWT?",
        ),
      );
    console.error(err);
  }
  return;
});

app.post("/auth/join", async (req, res) => {
  if (!req.session.userid) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Wrong Request",
          "You need to login first.",
        ),
      );
    return;
  }

  const namePattern = /^[a-zA-Z0-9_-]{5,12}$/;
  const isValidated = namePattern.test(req.body.displayName);
  if (!isValidated) {
    res
      .status(400)
      .json(
        createErrorResponse("failed", "Wrong Format", "Wrong name format."),
      );
    return;
  }

  const results = await knex("users")
    .select("nickname")
    .where("nickname", req.body.displayName);
  if (!results[0]) {
    await knex("users").insert({
      nickname: req.body.displayName,
      userid: req.session.userid,
      date: new Date(),
      email: req.session.email,
      settings: JSON.stringify(settingsConfig),
      skins: '["Default"]',
      tutorial: 3,
      picture: req.session.picture,
      background: `${config.project.cdn}/albums/75/urlate.webp`,
      alias: 0,
      rating: 0,
      rankHistory: "[]",
      banner: "[]",
      recentPlay: "[]",
      scoreSum: "0",
      accuracy: "0",
      playtime: 0,
      "1stNum": 0,
      ap: 0,
      fc: 0,
      clear: 0,
      ownedAlias: "[]",
      achievements: "[]",
      explicit: 0,
    });
    delete req.session.tempName;
    req.session.save(() => {
      res.status(200).json(createSuccessResponse("success"));
    });
  } else {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Exist Name",
          "The name sent already exists.",
        ),
      );
  }
});

app.get("/user", async (req, res) => {
  if (!req.session.userid) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "UserID Required",
          "UserID is required for this task.",
        ),
      );
    return;
  }

  const results = await knex("users")
    .select(
      "nickname",
      "settings",
      "skins",
      "userid",
      "tutorial",
      "picture",
      "explicit",
    )
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

  res.status(200).json({ result: "success", user: results[0] });
});

app.post("/user", async (req, res) => {
  if (!req.body.userid) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "UserID Required",
          "UserID is required for this task.",
        ),
      );
    return;
  }

  const results = await knex("users")
    .select("nickname", "settings")
    .where("userid", req.body.userid);
  if (!results.length) {
    res
      .status(400)
      .json(
        createErrorResponse("failed", "Failed to Load", "Failed to load data."),
      );
    return;
  }

  res.status(200).json({ result: "success", user: results[0] });
});

app.get("/profile/:uid", async (req, res) => {
  const results = await knex("users")
    .select(
      "nickname",
      "skins",
      "picture",
      "background",
      "alias",
      "rating",
      "rankHistory",
      "banner",
      "recentPlay",
      "scoreSum",
      "accuracy",
      "playtime",
      "1stNum",
      "ap",
      "fc",
      "clear",
      "ownedAlias",
      "explicit",
    )
    .where("userid", req.params.uid);
  const users = await knex("users").orderBy("rating", "desc");
  const rank = users.findIndex((user) => user.userid === req.params.uid) + 1;
  if (!results.length) {
    res
      .status(400)
      .json(
        createErrorResponse("failed", "Failed to Load", "Cannot find user."),
      );
    return;
  }

  res.status(200).json({ result: "success", user: results[0], rank });
});

app.get("/profilePic/:username", async (req, res) => {
  const results = await knex("users")
    .select("picture")
    .where("nickname", req.params.username);
  if (!results.length) {
    res
      .status(400)
      .json(
        createErrorResponse("failed", "Failed to Load", "Cannot find user."),
      );
    return;
  }

  res.status(200).json({ result: "success", picture: results[0].picture });
});

app.get("/tracks", async (req, res) => {
  const results = await knex("tracks").select(
    "name",
    "fileName",
    "producer",
    "bpm",
    "difficulty",
    "originalName",
  );
  if (!results.length) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Failed to Load",
          "Failed to load tracks. It may be a problem with the DB.",
        ),
      );
    return;
  }

  res.status(200).json({ result: "success", tracks: results });
});

app.get("/track/:name", async (req, res) => {
  const results = await knex("tracks")
    .select("name", "fileName", "producer", "bpm", "difficulty", "originalName")
    .where("name", req.params.name);
  if (!results.length) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Failed to Load",
          "Failed to load track. It may be a problem with the DB.",
        ),
      );
    return;
  }

  res.status(200).json({ result: "success", track: results });
});

app.get("/trackInfo/:name", async (req, res) => {
  const results = await knex("patternInfo")
    .select("bpm", "bullet_density", "note_density", "speed")
    .where("name", req.params.name);
  if (!results.length) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Failed to Load",
          "Failed to load track data. It may be a problem with the DB.",
        ),
      );
    return;
  }
  res.status(200).json({ result: "success", info: results });
});

app.put("/settings", async (req, res) => {
  if (!req.session.userid) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "UserID Required",
          "UserID is required for this task.",
        ),
      );
    return;
  }
  try {
    await knex("users")
      .update({ settings: JSON.stringify(req.body.settings) })
      .where("userid", req.session.userid);
  } catch (e) {
    let message;
    if (e instanceof Error) message = e.message;
    else message = String(e);
    res
      .status(400)
      .json(
        createErrorResponse("failed", "Error occured while updating", message),
      );
    return;
  }
  res.status(200).json(createSuccessResponse("success"));
});

app.put("/profile/:element", async (req, res) => {
  if (!req.session.userid && (!req.body.userid || !req.body.secret)) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "UserID Required",
          "UserID is required for this task.",
        ),
      );
    return;
  }
  try {
    const userid = req.session.userid ? req.session.userid : req.body.userid;
    const users = await knex("users")
      .select("explicit")
      .where("userid", userid);
    let explicit = users[0].explicit;
    switch (req.params.element) {
      case "alias":
        await knex("users")
          .update({ alias: req.body.value })
          .where("userid", userid);
        break;
      case "background":
        if (req.body.secret !== config.project.secretKey) {
          res
            .status(400)
            .json(
              createErrorResponse(
                "failed",
                "Authorize failed",
                "Project secret key is not vaild.",
              ),
            );
          return;
        }
        if (req.body.explicit && explicit < 2) explicit += 2;
        else if (explicit >= 2) explicit -= 2;
        await knex("users")
          .update({ background: req.body.value, explicit })
          .where("userid", userid);
        break;
      case "picture":
        if (req.body.secret !== config.project.secretKey) {
          res
            .status(400)
            .json(
              createErrorResponse(
                "failed",
                "Authorize failed",
                "Project secret key is not vaild.",
              ),
            );
          return;
        }
        if (req.body.explicit && explicit % 2 == 0) explicit++;
        else if (explicit % 2 == 1) explicit--;
        await knex("users")
          .update({ picture: req.body.value, explicit })
          .where("userid", userid);
        break;
      case "banner":
        await knex("users")
          .update({ banner: req.body.value })
          .where("userid", userid);
        break;
      default:
        res
          .status(400)
          .json(
            createErrorResponse(
              "failed",
              "Error occured while updating",
              "Undefined element name.",
            ),
          );
        return;
    }
  } catch (e) {
    let message;
    if (e instanceof Error) message = e.message;
    else message = String(e);
    res
      .status(400)
      .json(
        createErrorResponse("failed", "Error occured while updating", message),
      );
    return;
  }
  res.status(200).json(createSuccessResponse("success"));
});

app.put("/tutorial", async (req, res) => {
  if (!req.session.userid) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "UserID Required",
          "UserID is required for this task.",
        ),
      );
    return;
  }
  try {
    await knex("users")
      .update({ tutorial: 1 })
      .where("userid", req.session.userid);
    observer(`${req.session.userid}`, "TUTORIAL_CLEAR");
  } catch (e) {
    let message;
    if (e instanceof Error) message = e.message;
    else message = String(e);
    res
      .status(400)
      .json(
        createErrorResponse("failed", "Error occured while updating", message),
      );
    return;
  }
  res.status(200).json(createSuccessResponse("success"));
});

app.get("/teamProfile/:name", async (req, res) => {
  const results = await knex("teamProfiles")
    .select("data")
    .where("name", req.params.name);
  if (!results.length) {
    res
      .status(400)
      .json(
        createErrorResponse("failed", "Failed to Load", "Failed to load data."),
      );
    return;
  }
  res.status(200).json({ result: "success", data: results[0].data });
});

app.get("/trackCount/:name", async (req, res) => {
  res.end();
});

app.put("/playRecord", async (req, res) => {
  //doesn't scan the entire record yet
  //userid, username, rank, score, maxCombo, perfect, great, good, bad, miss, bullet, accuracy, record
  if (!req.session.userid) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "UserID Required",
          "UserID is required for this task.",
        ),
      );
    return;
  }

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

  // 신원은 세션에서 확정된 값만 신뢰합니다. 클라이언트가 보낸 userid/username은 사용하지 않습니다.
  const nickname: string = results[0].nickname;

  // 트랙 이름은 파일 경로와 DB 조회에 쓰이므로 안전한 형식만 허용합니다.
  const trackName = req.body.name;
  if (!isSafeSegment(trackName) || !isSafeSegment(nickname)) {
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

  // 판정 카운트/점수/콤보는 유한한 비음수 정수만 허용합니다(이상치·치팅 방지).
  const perfect = toFiniteNonNegInt(req.body.perfect);
  const great = toFiniteNonNegInt(req.body.great);
  const good = toFiniteNonNegInt(req.body.good);
  const bad = toFiniteNonNegInt(req.body.bad);
  const miss = toFiniteNonNegInt(req.body.miss);
  const bullet = toFiniteNonNegInt(req.body.bullet);
  const score = toFiniteNonNegInt(req.body.score);
  const maxCombo = toFiniteNonNegInt(req.body.maxCombo);
  const difficultySelection = toFiniteNonNegInt(req.body.difficultySelection);
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
  // 서버가 재계산한 rank/accuracy와 클라이언트 주장이 일치하는지 확인합니다.
  // NOTE: score(record) 자체는 여전히 클라이언트 계산값입니다. 완전한 치팅 방지에는
  // 서버측 리플레이 재생 검증이 필요하며, 이는 후속 과제입니다.
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

  // 로그 경로는 검증된 세그먼트만으로 구성하고 최종 경로가 로그 루트 하위인지 확인합니다.
  const logsRoot = path.resolve(__dirname, "../logs");
  const logDir = path.resolve(logsRoot, nickname, trackName);
  if (logDir !== logsRoot && !logDir.startsWith(logsRoot + path.sep)) {
    res
      .status(400)
      .json(createErrorResponse("failed", "Wrong Format", "Invalid log path."));
    return;
  }
  const logFile = path.join(logDir, `${Date.now()}.json`);
  fs.outputJson(logFile, req.body.record).catch((err) => signale.error(err));

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
    const recordRes = await fetch(
      `http://localhost:${config.project.port}/record`,
      {
        method: "PUT",
        body: JSON.stringify({
          secret: config.project.secretKey,
          name: trackName,
          nickname,
          rank,
          record: score,
          maxcombo: maxCombo,
          medal,
          difficultySelection,
          difficulty,
          judge: `${perfect} / ${great} / ${good} / ${bad} / ${miss} / ${bullet}`,
          accuracy,
          uid: req.session.userid,
        }),
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
    const data = (await recordRes.json()) as SimpleResponse;
    if (data.result == "success") {
      res.status(200).json(createSuccessResponse("success"));
    } else {
      res
        .status(400)
        .json(
          createErrorResponse(
            "failed",
            "Failed to Update",
            "Failed to update score.",
          ),
        );
    }
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

app.put("/record", async (req, res) => {
  if (req.body.secret !== config.project.secretKey) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Authorize failed",
          "Project secret key is not vaild.",
        ),
      );
    return;
  }
  try {
    let isBest = 0;
    const result = await knex("trackRecords")
      .select("record", "medal", "index")
      .where("nickname", req.body.nickname)
      .where("name", req.body.name)
      .where("isBest", 1)
      .where("difficulty", req.body.difficultySelection);
    if (result.length && result[0].record < req.body.record) {
      isBest = 1;
      await knex("trackRecords")
        .update({
          isBest: 0,
        })
        .where("index", result[0].index);
    }
    if (!result.length) isBest = 1;
    const index = uuid();
    let rating = Number(
      Math.round(
        (Number(req.body.record) / 100000000) *
          Number(req.body.accuracy) *
          Number(req.body.difficulty),
      ),
    );
    let ratingDiff = rating;
    const ratingBest = await knex("trackRecords")
      .select("rating", "index")
      .where("nickname", req.body.nickname)
      .where("name", req.body.name)
      .where("difficulty", req.body.difficultySelection)
      .orderBy("rating", "desc")
      .limit(1);
    if (ratingBest.length) {
      if (Number(ratingBest[0].rating) > rating) rating = 0;
      else {
        await knex("trackRecords")
          .update({
            rating: 0,
          })
          .where("index", ratingBest[0].index);
        ratingDiff = rating - Number(ratingBest[0].rating);
      }
    }
    await knex("trackRecords").insert({
      name: req.body.name,
      nickname: req.body.nickname,
      rank: req.body.rank,
      record: req.body.record,
      maxcombo: req.body.maxcombo,
      medal: req.body.medal,
      difficulty: req.body.difficultySelection,
      date: new Date(),
      isBest,
      index,
      judge: req.body.judge,
      accuracy: req.body.accuracy,
      rating,
    });
    const user = await knex("users")
      .where("nickname", req.body.nickname)
      .select(
        "rating",
        "scoreSum",
        "accuracy",
        "recentPlay",
        "playtime",
        "1stNum",
        "ap",
        "fc",
        "clear",
      );
    let ap = 0,
      fc = 0,
      clear = 0,
      medal = Number(req.body.medal);
    if (isBest) {
      if (result.length) medal = medal - result[0].medal;
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
      const allRecords = await knex("trackRecords")
        .select("nickname")
        .where("name", req.body.name)
        .where("isBest", 1)
        .where("difficulty", req.body.difficultySelection)
        .orderBy("record", "desc")
        .limit(1);
      if (allRecords[0].nickname == req.body.nickname) isBest = 2;
    }
    await knex("users")
      .where("nickname", req.body.nickname)
      .update({
        rating: Number(user[0].rating) + ratingDiff,
        scoreSum: Number(user[0].scoreSum) + Number(req.body.record),
        accuracy: (
          Math.round(
            ((Number(user[0].accuracy) * Number(user[0].playtime) +
              Number(req.body.accuracy)) *
              100) /
              (Number(user[0].playtime) + 1),
          ) / 100
        ).toFixed(2),
        recentPlay: JSON.stringify(
          [index, ...JSON.parse(user[0].recentPlay)].slice(0, 10),
        ),
        playtime: Number(user[0].playtime) + 1,
        ap: Number(user[0].ap) + ap,
        fc: Number(user[0].fc) + fc,
        clear: Number(user[0].clear) + clear,
        "1stNum": Number(user[0]["1stNum"]) + (isBest == 2 ? 1 : 0),
      });
  } catch (e) {
    console.error(e);
    let message;
    if (e instanceof Error) message = e.message;
    else message = String(e);
    res
      .status(400)
      .json(
        createErrorResponse("failed", "Error occured while updating", message),
      );
    return;
  }
  res.status(200).json(createSuccessResponse("success"));
});

app.get("/record/:index", async (req, res) => {
  const results = await knex("trackRecords")
    .select(
      "name",
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
    .where("index", req.params.index);
  if (!results.length) {
    res.status(200).json(createSuccessResponse("empty"));
    return;
  }
  res.status(200).json({ result: "success", results });
});

app.get("/record/:track/:name", async (req, res) => {
  const results = await knex("trackRecords")
    .select("rank", "record", "maxcombo", "medal", "difficulty", "date")
    .where("nickname", req.params.name)
    .where("name", req.params.track)
    .where("isBest", 1)
    .orderBy("difficulty", "DESC");
  if (!results.length) {
    res.status(200).json(createSuccessResponse("empty"));
    return;
  }
  res.status(200).json({ result: "success", results });
});

app.get("/bestRecords/:nickname", async (req, res) => {
  const results = await knex("trackRecords")
    .select(
      "name",
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
    .where("nickname", req.params.nickname)
    .whereNot("rating", 0)
    .orderBy("difficulty", "desc")
    .orderBy("rating", "desc");
  res.status(200).json({ result: "success", results: results.slice(0, 10) });
});

app.get(
  "/records/:track/:difficulty/:order/:sort/:nickname",
  async (req, res) => {
    const results = await knex("trackRecords")
      .select("rank", "record", "maxcombo", "nickname")
      .where("name", req.params.track)
      .where("difficulty", req.params.difficulty)
      .where("isBest", 1)
      .orderBy(req.params.order, req.params.sort);
    const rank =
      results
        .map((d) => {
          return d["nickname"];
        })
        .indexOf(req.params.nickname) + 1;
    res
      .status(200)
      .json({ result: "success", results: results.slice(0, 100), rank: rank });
  },
);

app.put("/coupon", async (req, res) => {
  if (!req.session.userid) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "UserID Required",
          "UserID is required for this task.",
        ),
      );
    return;
  }
  try {
    const code = req.body.code;
    const couponArr = await knex("codes")
      .select("reward", "used", "usedUser")
      .where("code", code);
    if (couponArr.length != 1) {
      res
        .status(400)
        .json(
          createErrorResponse("failed", "Invalid code", "Invalid code sent."),
        );
      return;
    }
    const coupon = couponArr[0];
    if (coupon.used) {
      res
        .status(400)
        .json(
          createErrorResponse(
            "failed",
            "Used code",
            "The code sent has already been used.",
          ),
        );
      return;
    }
    const usedUser = JSON.parse(coupon.usedUser);
    if (usedUser) {
      if (usedUser.indexOf(req.session.userid) != -1) {
        res
          .status(400)
          .json(
            createErrorResponse(
              "failed",
              "Used code",
              "The code sent has already been used.",
            ),
          );
        return;
      }
    }
    const reward = JSON.parse(coupon.reward);
    if (reward.type == "skin") {
      const statusArr = await knex("users")
        .select("skins")
        .where("userid", req.session.userid);
      const skins = JSON.parse(statusArr[0].skins);
      if (skins.indexOf(reward.content) != -1) {
        res
          .status(400)
          .json(
            createErrorResponse(
              "failed",
              "Already have",
              "User already has the skin.",
            ),
          );
        return;
      } else {
        skins.push(reward.content);
        await knex("users")
          .update({ skins: JSON.stringify(skins) })
          .where("userid", req.session.userid);
      }
    }
    if (!reward.nolimit) {
      await knex("codes").update({ used: 1 }).where("code", code);
    } else {
      usedUser.push(req.session.userid);
      await knex("codes")
        .update({ usedUser: JSON.stringify(usedUser) })
        .where("code", code);
    }
  } catch (e) {
    let message;
    if (e instanceof Error) message = e.message;
    else message = String(e);
    res
      .status(400)
      .json(
        createErrorResponse("failed", "Error occured while loading", message),
      );
    return;
  }
  res.status(200).json(createSuccessResponse("success"));
});

app.get("/ranking/:sort/:limit", async (req, res) => {
  let results;
  try {
    results = await knex("users")
      .select(
        "nickname",
        "rating",
        "picture",
        "userid",
        "accuracy",
        "scoreSum",
        "explicit",
      )
      .orderBy("rating", req.params.sort)
      .limit(Number(req.params.limit));
  } catch (e) {
    let message;
    if (e instanceof Error) message = e.message;
    else message = String(e);
    res
      .status(400)
      .json(
        createErrorResponse("failed", "Error occured while loading", message),
      );
    return;
  }
  res.status(200).json({ result: "success", results });
});

app.get("/auth/logout", (req, res) => {
  delete req.session.userid;
  delete req.session.tempName;
  delete req.session.email;
  delete req.session.picture;
  req.session.save(() => {
    if (req.query.redirect == "true") {
      let adder = "";
      if (req.query.shutdowned == "true") adder = "/?shutdowned=true";
      res.redirect(config.project.url + adder);
    } else {
      res.status(200).json(createSuccessResponse("success"));
    }
  });
});

app.put("/CPLrecord", async (req, res) => {
  if (req.body.secret !== config.project.secretKey) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Authorize failed",
          "Project secret key is not vaild.",
        ),
      );
    return;
  }
  try {
    let isBest = 0;
    let gap = 0;
    const result = await knex("CPLtrackRecords")
      .select("record")
      .where("nickname", req.body.nickname)
      .where("name", req.body.name)
      .where("isBest", 1)
      .where("difficulty", req.body.difficulty)
      .where("id", req.body.id);
    if (result.length && result[0].record < req.body.record) {
      isBest = 1;
      gap = req.body.record - result[0].record;
      await knex("CPLtrackRecords")
        .update({
          isBest: 0,
        })
        .where("nickname", req.body.nickname)
        .where("name", req.body.name)
        .where("isBest", 1)
        .where("difficulty", req.body.difficulty)
        .where("id", req.body.id);
    }
    if (!result.length) {
      isBest = 1;
      gap = req.body.record;
    }
    await knex("CPLtrackRecords").insert({
      id: req.body.id,
      name: req.body.name,
      nickname: req.body.nickname,
      rank: req.body.rank,
      record: req.body.record,
      maxcombo: req.body.maxcombo,
      difficulty: req.body.difficulty,
      isBest: isBest,
    });
    const total = await knex("CPLTotalTrackRecords")
      .select("record")
      .where("nickname", req.body.nickname)
      .where("name", req.body.name)
      .where("difficulty", req.body.difficulty);
    const score = total[0].record + gap;
    if (total.length) {
      await knex("CPLTotalTrackRecords")
        .update({
          record: score,
        })
        .where("nickname", req.body.nickname)
        .where("name", req.body.name)
        .where("difficulty", req.body.difficulty);
    } else {
      await knex("CPLTotalTrackRecords").insert({
        name: req.body.name,
        nickname: req.body.nickname,
        record: req.body.record,
        difficulty: req.body.difficulty,
      });
    }
  } catch (e) {
    let message;
    if (e instanceof Error) message = e.message;
    else message = String(e);
    res
      .status(400)
      .json(
        createErrorResponse("failed", "Error occured while updating", message),
      );
    return;
  }
  res.status(200).json(createSuccessResponse("success"));
});

app.get(
  "/CPLrecords/:track/:difficulty/:order/:sort/:nickname",
  async (req, res) => {
    const results = await knex("CPLTotalTrackRecords")
      .select("record", "nickname")
      .where("name", req.params.track)
      .where("difficulty", req.params.difficulty)
      .orderBy(req.params.order, req.params.sort);
    const rank =
      results
        .map((d) => {
          return d["nickname"];
        })
        .indexOf(req.params.nickname) + 1;
    res
      .status(200)
      .json({ result: "success", results: results.slice(0, 100), rank: rank });
  },
);

app.get("/CPLpatternList/:name/:difficulty", async (req, res) => {
  const results = await knex("CPLpatternInfo")
    .select(
      "id",
      "patternName",
      "name",
      "author",
      "description",
      "analyzed",
      "community",
      "star",
      "difficulty",
    )
    .where("name", req.params.name)
    .where("difficulty", req.params.difficulty);
  res.status(200).json({ result: "success", data: results });
});

app.get("/CPLtrackInfo/:name", async (req, res) => {
  const results = await knex("CPLpatternInfo")
    .select("name", "difficulty")
    .where("name", req.params.name);
  res.status(200).json({ result: "success", info: results });
});

app.get("/notice/:lang", async (req, res) => {
  const results = await knex("notice")
    .select("date", `title_${req.params.lang}`, `url_${req.params.lang}`)
    .orderBy("date", "desc")
    .limit(1);
  if (!results.length) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Failed to Load",
          "Failed to load skin data.",
        ),
      );
    return;
  }
  res.status(200).json({ result: "success", data: results[0] });
});

app.listen(config.project.port, () => {
  signale.info(new Date());
  signale.success(`API Server running at port ${config.project.port}.`);
  redisClient.connect();
});
