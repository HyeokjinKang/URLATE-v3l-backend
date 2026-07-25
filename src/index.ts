import cookieParser from "cookie-parser";
import express from "express";
import session from "express-session";
import { RedisStore } from "connect-redis";
import signale from "signale";
import fetch from "node-fetch";
import { v4 } from "uuid";
import schedule from "node-schedule";
import fs from "fs-extra";
import path from "path";
import { OAuth2Client } from "google-auth-library";
import Knex from "knex";

import { SimpleResponse } from "./types/config.schema";
import {
  createSuccessResponse,
  createErrorResponse,
  createStatusResponse,
} from "./api-response";
import { observer } from "./achievements";
import config from "./config";
import { redisClient } from "./redis";
import { getOrSet, invalidate, invalidateGroup, keys } from "./cache";
import {
  acquireRebuildLock,
  countHigherRating,
  rebuild as rebuildRatingIndex,
  releaseRebuildLock,
  setRating,
} from "./rating-index";

import settingsConfig from "../config/settings.json";

const gidClient = new OAuth2Client(config.google.clientId);

const app = express();
app.locals.pretty = true;

const redisStore = new RedisStore({
  client: redisClient,
  prefix: "urlate:",
});

const knex = Knex({
  client: "mysql2",
  connection: {
    host: config.database.host,
    user: config.database.user,
    password: config.database.password,
    database: config.database.db,
  },
  pool: { min: 0, max: 7 },
});

// production 이외의 모드에서만 secure 쿠키를 해제합니다(로컬 HTTP 개발용).
const isProduction = config.project.mode !== "test";

// 리버스 프록시(HTTPS 종단) 뒤에서 X-Forwarded-Proto를 신뢰하여
// secure 쿠키가 정상 동작하도록 합니다.
app.set("trust proxy", 1);

const sessionMiddleware = session({
  store: redisStore,
  resave: config.session.resave ?? false,
  saveUninitialized: config.session.saveUninitialized ?? false,
  secret: config.session.secret,
  name: "urlate",
  cookie: {
    domain: config.session.domain,
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24 * 14, // 14일
  },
});

app.use(sessionMiddleware);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

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

// Redis 기반 rate limiter. PM2 클러스터 환경에서도 인스턴스 간 카운터가 공유됩니다.
const rateLimit =
  (options: { windowSec: number; max: number; prefix: string }) =>
  async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const key = `ratelimit:${options.prefix}:${ip}`;
      const count = await redisClient.incr(key);
      if (count === 1) {
        await redisClient.expire(key, options.windowSec);
      }
      if (count > options.max) {
        res
          .status(429)
          .json(
            createErrorResponse(
              "failed",
              "Too Many Requests",
              "Rate limit exceeded. Please try again later.",
            ),
          );
        return;
      }
    } catch (err) {
      // Redis 장애 시 요청을 막지 않고 통과시킵니다(가용성 우선). 오류는 기록합니다.
      signale.error(err);
    }
    next();
  };

const isValidNickname = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{5,12}$/.test(value);

const isValidFileName = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9]{1,255}$/.test(value);

// 유한한 비음수 정수만 허용합니다(치팅용 이상치 방지).
const toFiniteNonNegInt = (value: unknown): number | null => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
};

// 정렬 방향 화이트리스트입니다.
const SORT_DIRECTIONS = new Set(["asc", "desc"]);
// trackRecords 정렬 가능 컬럼 화이트리스트입니다.
const TRACK_ORDER_COLUMNS = new Set([
  "rank",
  "record",
  "maxcombo",
  "accuracy",
  "rating",
]);
// 다국어 공지 언어 화이트리스트입니다.
const NOTICE_LANGS = new Set(["ko", "en"]);

// 판정 점수 이론적 상한(정합성 검증용). 실제 최고 기록보다 충분히 큰 값입니다.
const MAX_SCORE = 200_000_000;

// 전역 rate limit: IP당 분당 요청 수를 제한하여 남용/DoS를 완화합니다.
app.use(rateLimit({ windowSec: 60, max: 600, prefix: "global" }));

// rating 인덱스(ZSET)를 users 테이블에서 다시 채웁니다.
// 최초 기동이나 Redis 재시작 이후를 대비한 복구 경로입니다.
// 성공한 뒤에도 락을 만료될 때까지 그대로 두어, 인덱스가 빈 동안 요청이 몰려도
// users 전체 조회가 연달아 발생하지 않게 합니다(디바운스).
const rebuildRatingIndexIfNeeded = async () => {
  if (!(await acquireRebuildLock())) return;
  try {
    const users = await knex("users").select("userid", "rating");
    await rebuildRatingIndex(users);
  } catch (err) {
    signale.error(err);
    // 실패한 시도는 곧바로 다시 시도할 수 있도록 락을 풉니다.
    await releaseRebuildLock();
  }
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const updateRankHistory = schedule.scheduleJob("59 23 * * *", async () => {
  signale.info(new Date());
  signale.pending(`Updating rank history...`);
  const users = await knex("users")
    .select("userid", "rankHistory", "rating")
    .orderBy("rating", "desc");
  // 하루 한 번 rating 인덱스를 통째로 다시 만들어 증분 갱신에서 생길 수 있는
  // 누락을 바로잡습니다.
  await rebuildRatingIndex(users);
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
  const userid = req.session.userid;
  if (!userid) {
    res.status(200).json(createStatusResponse("Not logined"));
    return;
  }

  // 가입 여부는 한번 참이 되면 되돌아가지 않으므로 길게 캐싱해도 안전합니다.
  // (가입 시점에 /auth/join에서 무효화합니다.)
  const registered = await getOrSet(
    "authStatus",
    keys.authStatus(userid),
    async () => {
      const results = await knex("users")
        .select("userid")
        .where("userid", userid);
      return results.length > 0;
    },
  );
  if (!registered) {
    res
      .status(200)
      .json({ status: "Not registered", tempName: req.session.tempName });
    return;
  }

  res.status(200).json(createStatusResponse("Logined"));
});

app.post(
  "/auth/login",
  rateLimit({ windowSec: 300, max: 20, prefix: "login" }),
  async (req, res) => {
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
  },
);

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
    // 가입 즉시 로그인 상태로 보이도록 가입 여부 캐시를 비웁니다.
    await invalidate(keys.authStatus(req.session.userid));
    await setRating(req.session.userid, 0);
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
  const userid = req.session.userid;
  if (!userid) {
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

  // 본인 데이터이므로 키에 userid를 포함해 유저 간 교차 노출을 막습니다.
  // 설정/튜토리얼/쿠폰/프로필 변경 시 즉시 무효화합니다.
  const results = await getOrSet(
    "user",
    keys.user(userid),
    () =>
      knex("users")
        .select(
          "nickname",
          "settings",
          "skins",
          "userid",
          "tutorial",
          "picture",
          "explicit",
        )
        .where("userid", userid),
    { cacheEmpty: false },
  );
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

app.get("/profile/:uid", async (req, res) => {
  const uid = req.params.uid;
  const results = await getOrSet(
    "profile",
    keys.profile(uid),
    () =>
      knex("users")
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
        .where("userid", uid),
    { cacheEmpty: false },
  );
  if (!results.length) {
    res
      .status(400)
      .json(
        createErrorResponse("failed", "Failed to Load", "Cannot find user."),
      );
    return;
  }

  // 순위는 Redis Sorted Set으로 O(log N)에 계산합니다.
  // ZCOUNT는 SQL의 COUNT(*) WHERE rating > ? 와 의미가 같아 동점자 처리도 동일합니다.
  const rating = Number(results[0].rating);
  let higher = await countHigherRating(rating);
  if (higher === null) {
    // 인덱스가 아직 없으면(최초 기동·Redis 재시작) DB로 폴백하고 백그라운드에서 채웁니다.
    const [row] = await knex("users")
      .where("rating", ">", results[0].rating)
      .count({ higher: "*" });
    higher = Number(row.higher);
    rebuildRatingIndexIfNeeded().catch((err) => signale.error(err));
  }
  const rank = higher + 1;

  res.status(200).json({ result: "success", user: results[0], rank });
});

app.get("/profilePic/:username", async (req, res) => {
  const username = req.params.username;
  const results = await getOrSet(
    "profilePic",
    keys.profilePic(username),
    () => knex("users").select("picture").where("nickname", username),
    { cacheEmpty: false },
  );
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
  // 모든 페이지 진입마다 호출되지만 곡이 추가될 때만 바뀌는 데이터입니다.
  const results = await getOrSet(
    "tracks",
    keys.tracksAll(),
    () =>
      knex("tracks").select(
        "name",
        "fileName",
        "producer",
        "bpm",
        "difficulty",
        "originalName",
      ),
    { cacheEmpty: false },
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
  const name = req.params.name;
  const results = await getOrSet(
    "tracks",
    keys.track(name),
    () =>
      knex("tracks")
        .select(
          "name",
          "fileName",
          "producer",
          "bpm",
          "difficulty",
          "originalName",
        )
        .where("name", name),
    { cacheEmpty: false },
  );
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

app.get("/trackInfo/:filename", async (req, res) => {
  // 곡을 고를 때마다 호출되지만 패턴이 갱신될 때만 바뀌는 데이터입니다.
  const filename = req.params.filename;
  const results = await getOrSet(
    "trackInfo",
    keys.trackInfo(filename),
    () =>
      knex("patternInfo")
        .select("bpm", "bullet_density", "note_density", "speed")
        .where("filename", filename),
    { cacheEmpty: false },
  );
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
  const userid = req.session.userid;
  if (!userid) {
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
      .where("userid", userid);
    await invalidate(keys.user(userid));
  } catch (e) {
    signale.error(e);
    res
      .status(500)
      .json(
        createErrorResponse(
          "failed",
          "Error occured while updating",
          "Internal server error.",
        ),
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
      .select("explicit", "ownedAlias", "banner", "nickname")
      .where("userid", userid);
    if (!users.length) {
      res
        .status(400)
        .json(
          createErrorResponse("failed", "Failed to Load", "Cannot find user."),
        );
      return;
    }
    // background(2), picture(1) explicit 여부를 담는 비트필드입니다.
    let explicit = Number(users[0].explicit);
    switch (req.params.element) {
      case "alias": {
        // 소유한 alias(칭호)만 장착할 수 있도록 검증합니다.
        const ownedAlias: number[] = JSON.parse(users[0].ownedAlias);
        const selected = Number(req.body.value);
        if (!Number.isInteger(selected) || !ownedAlias.includes(selected)) {
          res
            .status(400)
            .json(
              createErrorResponse(
                "failed",
                "Not Owned",
                "You do not own the selected alias.",
              ),
            );
          return;
        }
        await knex("users").update({ alias: selected }).where("userid", userid);
        break;
      }
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
        // background explicit = 비트 1(값 2)
        explicit = req.body.explicit ? explicit | 2 : explicit & ~2;
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
        // picture explicit = 비트 0(값 1)
        explicit = req.body.explicit ? explicit | 1 : explicit & ~1;
        await knex("users")
          .update({ picture: req.body.value, explicit })
          .where("userid", userid);
        break;
      case "banner": {
        // 배너는 가시성 토글((-) 마커)만 허용합니다. 소유 목록 자체는 변경할 수 없습니다.
        let submitted: unknown;
        try {
          submitted =
            typeof req.body.value === "string"
              ? JSON.parse(req.body.value)
              : req.body.value;
        } catch {
          submitted = null;
        }
        const owned: string[] = JSON.parse(users[0].banner);
        const normalize = (arr: unknown): string[] | null => {
          if (!Array.isArray(arr)) return null;
          const names: string[] = [];
          for (const item of arr) {
            if (typeof item !== "string") return null;
            names.push(item.replace("(-)", ""));
          }
          return names.sort();
        };
        const submittedNames = normalize(submitted);
        const ownedNames = normalize(owned);
        if (
          !submittedNames ||
          !ownedNames ||
          submittedNames.length !== ownedNames.length ||
          submittedNames.some((n, i) => n !== ownedNames[i])
        ) {
          res
            .status(400)
            .json(
              createErrorResponse(
                "failed",
                "Invalid banner",
                "Banner list does not match owned banners.",
              ),
            );
          return;
        }
        await knex("users")
          .update({ banner: JSON.stringify(submitted) })
          .where("userid", userid);
        break;
      }
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
    // 변경된 프로필이 곧바로 보이도록 관련 캐시를 비웁니다.
    await invalidate(
      keys.profile(userid),
      keys.user(userid),
      keys.profilePic(users[0].nickname),
    );
  } catch (e) {
    signale.error(e);
    res
      .status(500)
      .json(
        createErrorResponse(
          "failed",
          "Error occured while updating",
          "Internal server error.",
        ),
      );
    return;
  }
  res.status(200).json(createSuccessResponse("success"));
});

app.put("/tutorial", async (req, res) => {
  const userid = req.session.userid;
  if (!userid) {
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
    await knex("users").update({ tutorial: 1 }).where("userid", userid);
    await invalidate(keys.user(userid), keys.profile(userid));
    observer(`${userid}`, "TUTORIAL_CLEAR");
  } catch (e) {
    signale.error(e);
    res
      .status(500)
      .json(
        createErrorResponse(
          "failed",
          "Error occured while updating",
          "Internal server error.",
        ),
      );
    return;
  }
  res.status(200).json(createSuccessResponse("success"));
});

app.get("/teamProfile/:name", async (req, res) => {
  const name = req.params.name;
  const results = await getOrSet(
    "teamProfile",
    keys.teamProfile(name),
    () => knex("teamProfiles").select("data").where("name", name),
    { cacheEmpty: false },
  );
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

  // 파일 이름은 파일 경로와 DB 조회에 쓰이므로 안전한 형식만 허용합니다.
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
  const logDir = path.resolve(logsRoot, nickname, fileName);
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
  // 트랜잭션 커밋 이후에 캐시를 비우기 위해 갱신된 값을 밖으로 꺼냅니다.
  let updatedUserid: string | null = null;
  let updatedRating = 0;
  try {
    // read-modify-write 경쟁 조건 방지를 위해 트랜잭션 + 사용자 행 잠금으로 처리합니다.
    await knex.transaction(async (trx) => {
      // 난이도는 클라이언트 값을 신뢰하지 않고 tracks 테이블에서 권위 있는 값을 도출합니다.
      let difficultyValue = Number(req.body.difficulty);
      const trackRow = await trx("tracks")
        .select("difficulty")
        .where("fileName", req.body.fileName)
        .first();
      if (trackRow) {
        try {
          const arr = JSON.parse(trackRow.difficulty);
          const idx = Number(req.body.difficultySelection) - 1;
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
        .where("nickname", req.body.nickname)
        .where("filename", req.body.fileName)
        .where("isBest", 1)
        .where("difficulty", req.body.difficultySelection);
      if (result.length && result[0].record < req.body.record) {
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
          (Number(req.body.record) / 100000000) *
            Number(req.body.accuracy) *
            difficultyValue,
        ),
      );
      let ratingDiff = rating;
      const ratingBest = await trx("trackRecords")
        .select("rating", "index")
        .where("nickname", req.body.nickname)
        .where("filename", req.body.fileName)
        .where("difficulty", req.body.difficultySelection)
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
        filename: req.body.fileName,
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
      const user = await trx("users")
        .where("nickname", req.body.nickname)
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
        const allRecords = await trx("trackRecords")
          .select("nickname")
          .where("filename", req.body.fileName)
          .where("isBest", 1)
          .where("difficulty", req.body.difficultySelection)
          .orderBy("record", "desc")
          .limit(1);
        if (allRecords.length && allRecords[0].nickname == req.body.nickname)
          isBest = 2;
      }
      updatedUserid = String(user[0].userid);
      updatedRating = Number(user[0].rating) + ratingDiff;
      await trx("users")
        .where("nickname", req.body.nickname)
        .update({
          rating: updatedRating,
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
    });
  } catch (e) {
    signale.error(e);
    res
      .status(500)
      .json(
        createErrorResponse(
          "failed",
          "Error occured while updating",
          "Internal server error.",
        ),
      );
    return;
  }

  // 커밋이 끝난 뒤에만 캐시를 정리합니다. 방금 남긴 기록이 즉시 보여야 하므로
  // TTL 만료를 기다리지 않고 관련 키를 직접 비웁니다.
  try {
    await invalidate(
      keys.bestRecord(req.body.nickname, req.body.fileName),
      keys.bestRecords(req.body.nickname),
      keys.ranking("asc"),
      keys.ranking("desc"),
      updatedUserid ? keys.profile(updatedUserid) : null,
    );
    await invalidateGroup(
      keys.leaderboardGroup(req.body.fileName, req.body.difficultySelection),
    );
    if (updatedUserid) await setRating(updatedUserid, updatedRating);
  } catch (e) {
    // 캐시 정리 실패가 기록 저장 성공을 뒤집지는 않습니다.
    signale.error(e);
  }

  res.status(200).json(createSuccessResponse("success"));
});

app.get("/record/:index", async (req, res) => {
  // 프로필의 최근 플레이 10건이 한꺼번에 호출합니다. isBest/rating은 이후 플레이로
  // 바뀔 수 있어 짧은 TTL만 적용하고 별도 무효화는 하지 않습니다.
  const index = req.params.index;
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

app.get("/record/:filename/:nickname", async (req, res) => {
  // 곡 선택 화면이 트랙 수만큼 병렬 호출하는 가장 뜨거운 경로입니다.
  // 본인이 기록을 갱신할 때만 바뀌므로 /record 쓰기에서 정확히 무효화합니다.
  const { filename, nickname } = req.params;
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
    // 아직 플레이하지 않은 곡의 빈 결과도 캐싱합니다.
    // 곡 선택 화면에서는 이 경우가 오히려 다수이며, 그대로 두면 캐시 의미가 없습니다.
  );
  if (!results.length) {
    res.status(200).json(createSuccessResponse("empty"));
    return;
  }
  res.status(200).json({ result: "success", results });
});

app.get("/bestRecords/:nickname", async (req, res) => {
  const nickname = req.params.nickname;
  const results = await getOrSet(
    "bestRecord",
    keys.bestRecords(nickname),
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
        .where("nickname", nickname)
        .whereNot("rating", 0)
        .orderBy("difficulty", "desc")
        .orderBy("rating", "desc")
        // 응답은 어차피 10건만 사용하므로 DB에서부터 잘라 옵니다.
        .limit(10),
  );
  res.status(200).json({ result: "success", results });
});

app.get(
  "/records/:fileName/:difficulty/:order/:sort/:nickname",
  async (req, res) => {
    const order = req.params.order;
    const sort = (req.params.sort || "").toLowerCase();
    // orderBy 컬럼/방향을 화이트리스트로 제한합니다(식별자 주입 방지).
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

    const { fileName, difficulty, nickname } = req.params;
    // 순위표와 개인 순위는 같은 곡·난이도의 기록이 갱신될 때 함께 무효화되어야 하므로
    // 하나의 캐시 그룹으로 묶습니다.
    const group = keys.leaderboardGroup(fileName, difficulty);

    // 상위 100개만 조회합니다(전체 로드 방지).
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

    // 요청자 순위는 자신의 기록보다 앞선 인원 수를 COUNT로 계산합니다.
    const rank = await getOrSet(
      "leaderboard",
      keys.leaderboardRank(fileName, difficulty, order, sort, nickname),
      async () => {
        const self = await knex("trackRecords")
          .select(order)
          .where("filename", fileName)
          .where("difficulty", difficulty)
          .where("isBest", 1)
          .where("nickname", nickname)
          .first();
        if (!self) return 0;
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
    res.status(200).json({ result: "success", results, rank });
  },
);

app.put(
  "/coupon",
  rateLimit({ windowSec: 300, max: 30, prefix: "coupon" }),
  async (req, res) => {
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
    // 비즈니스 검증 실패를 트랜잭션 롤백과 함께 전달하기 위한 에러 타입입니다.
    class CouponError extends Error {
      constructor(
        public error: string,
        public description: string,
      ) {
        super(description);
      }
    }
    // 위 가드에서 세션이 확인되었으므로 트랜잭션 클로저에서 사용할 userid를 캡처합니다.
    const userid = req.session.userid;
    try {
      const code = req.body.code;
      // 동일 코드에 대한 동시 사용을 직렬화하기 위해 트랜잭션 + 행 잠금으로 처리합니다.
      await knex.transaction(async (trx) => {
        const couponArr = await trx("codes")
          .select("reward", "used", "usedUser")
          .where("code", code)
          .forUpdate();
        if (couponArr.length != 1) {
          throw new CouponError("Invalid code", "Invalid code sent.");
        }
        const coupon = couponArr[0];
        if (coupon.used) {
          throw new CouponError(
            "Used code",
            "The code sent has already been used.",
          );
        }
        const usedUser = JSON.parse(coupon.usedUser);
        if (usedUser) {
          if (usedUser.indexOf(userid) != -1) {
            throw new CouponError(
              "Used code",
              "The code sent has already been used.",
            );
          }
        }
        const reward = JSON.parse(coupon.reward);
        if (reward.type == "skin") {
          const statusArr = await trx("users")
            .select("skins")
            .where("userid", userid)
            .forUpdate();
          const skins = JSON.parse(statusArr[0].skins);
          if (skins.indexOf(reward.content) != -1) {
            throw new CouponError("Already have", "User already has the skin.");
          } else {
            skins.push(reward.content);
            await trx("users")
              .update({ skins: JSON.stringify(skins) })
              .where("userid", userid);
          }
        }
        if (!reward.nolimit) {
          await trx("codes").update({ used: 1 }).where("code", code);
        } else {
          usedUser.push(userid);
          await trx("codes")
            .update({ usedUser: JSON.stringify(usedUser) })
            .where("code", code);
        }
      });
      // 스킨 지급이 곧바로 반영되도록 본인 정보 캐시를 비웁니다.
      await invalidate(keys.user(userid), keys.profile(userid));
    } catch (e) {
      if (e instanceof CouponError) {
        res
          .status(400)
          .json(createErrorResponse("failed", e.error, e.description));
        return;
      }
      signale.error(e);
      res
        .status(500)
        .json(
          createErrorResponse(
            "failed",
            "Error occured while loading",
            "Internal server error.",
          ),
        );
      return;
    }
    res.status(200).json(createSuccessResponse("success"));
  },
);

app.get("/ranking/:sort/:limit", async (req, res) => {
  const sort = (req.params.sort || "").toLowerCase();
  if (!SORT_DIRECTIONS.has(sort)) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Wrong Format",
          "Invalid sort parameter.",
        ),
      );
    return;
  }
  // limit는 1~100 범위로 제한합니다(과도한 조회 방지).
  const limit = Math.min(
    Math.max(toFiniteNonNegInt(req.params.limit) ?? 0, 1),
    100,
  );
  let results;
  try {
    // limit이 달라도 정렬 결과의 앞부분을 자르는 것이므로,
    // 상위 100개를 한 번만 캐싱한 뒤 잘라서 응답합니다.
    const top = await getOrSet("ranking", keys.ranking(sort), () =>
      knex("users")
        .select(
          "nickname",
          "rating",
          "picture",
          "userid",
          "accuracy",
          "scoreSum",
          "explicit",
        )
        .orderBy("rating", sort)
        .limit(100),
    );
    results = top.slice(0, limit);
  } catch (e) {
    signale.error(e);
    res
      .status(500)
      .json(
        createErrorResponse(
          "failed",
          "Error occured while loading",
          "Internal server error.",
        ),
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

app.get("/notice/:lang", async (req, res) => {
  // 동적 컬럼명 조합에 사용되므로 lang을 화이트리스트로 제한합니다(식별자 주입 방지).
  if (!NOTICE_LANGS.has(req.params.lang)) {
    res
      .status(400)
      .json(
        createErrorResponse("failed", "Wrong Format", "Unsupported language."),
      );
    return;
  }
  const lang = req.params.lang;
  const results = await getOrSet("notice", keys.notice(lang), () =>
    knex("notice")
      .select("date", `title_${lang}`, `url_${lang}`)
      .orderBy("date", "desc")
      .limit(1),
  );
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

// 정의되지 않은 경로에 대한 404 처리입니다.
app.use((req, res) => {
  res
    .status(404)
    .json(createErrorResponse("failed", "Not Found", "Unknown endpoint."));
});

// 전역 에러 핸들러입니다. 라우트에서 전달된(또는 async 거부로 포워딩된) 오류를
// 서버측에만 기록하고 클라이언트에는 일반화된 메시지를 반환합니다(스택/내부 정보 노출 방지).
// Express는 4개 인자를 가진 미들웨어를 에러 핸들러로 인식하므로 next를 유지합니다.
app.use(
  (
    err: unknown,
    req: express.Request,
    res: express.Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    next: express.NextFunction,
  ) => {
    signale.error(err);
    if (res.headersSent) return;
    res
      .status(500)
      .json(
        createErrorResponse(
          "failed",
          "Internal Server Error",
          "An unexpected error occurred.",
        ),
      );
  },
);

app.listen(config.project.port, async () => {
  signale.info(new Date());
  signale.success(`API Server running at port ${config.project.port}.`);
  await redisClient.connect().catch((err) => signale.error(err));
  // 기동 직후 rating 인덱스를 준비해 첫 프로필 조회부터 ZSET을 쓰도록 합니다.
  rebuildRatingIndexIfNeeded().catch((err) => signale.error(err));
});
