import cookieParser from "cookie-parser";
import express from "express";
import session from "express-session";
import { RedisStore } from "connect-redis";
import signale from "signale";
import schedule from "node-schedule";
import { OAuth2Client } from "google-auth-library";

import {
  createSuccessResponse,
  createErrorResponse,
  createStatusResponse,
} from "./api-response";
import { observer } from "./achievements";
import config from "./config";
import { knex } from "./db";
import { isValidSecret } from "./secret";
import { redisClient } from "./redis";
import { submitRecord } from "./record";
import { cleanupReplayLogs, writeReplayLog } from "./replay-log";
import {
  isValidFileName,
  isValidNickname,
  isValidRecordIndex,
  parseJson,
  toDifficultySelection,
  toFiniteNonNegInt,
  MAX_SCORE,
  NOTICE_LANGS,
  SORT_DIRECTIONS,
  TRACK_ORDER_COLUMNS,
} from "./validate";
import { getOrSet, invalidate, keys } from "./cache";
import {
  acquireRebuildLock,
  countHigherRating,
  rebuild as rebuildRatingIndex,
  releaseRebuildLock,
  setRating,
} from "./rating-index";

import { defaultSettings, normalizeSettings } from "./settings";

// 마지막 안전망입니다. Node 15+는 처리되지 않은 프로미스 거부에서 프로세스를
// 종료하므로, 로그만 남기고 살아남게 해 단발성 오류가 전체 서비스를 끊지 않도록 합니다.
process.on("unhandledRejection", (reason) => {
  signale.error("Unhandled promise rejection:");
  signale.error(reason);
});

// uncaughtException 이후의 프로세스 상태는 신뢰할 수 없으므로 기록 후 종료하고
// 프로세스 매니저(pm2)의 재시작에 맡깁니다.
process.on("uncaughtException", (err) => {
  signale.fatal("Uncaught exception, shutting down:");
  signale.fatal(err);
  process.exit(1);
});

const gidClient = new OAuth2Client(config.google.clientId);

const app = express();
app.locals.pretty = true;

const redisStore = new RedisStore({
  client: redisClient,
  prefix: "urlate:",
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

/**
 * CSRF 방어입니다.
 *
 * 지금까지 방어는 세션 쿠키의 SameSite=lax 하나에만 의존했습니다. lax는 상위
 * 도메인을 공유하는 사이트(example.com <-> api.example.com) 사이에서는 쿠키를
 * 그대로 실어 보내므로, 서브도메인 중 하나라도 장악되면 모든 상태 변경 요청이
 * 통과합니다. 그래서 Origin(없으면 Referer)을 신뢰 목록과 대조하는 계층을
 * 하나 더 둡니다.
 *
 * Origin과 Referer가 모두 없는 요청은 통과시킵니다. 브라우저는 상태 변경
 * 요청에 Origin을 반드시 붙이므로, 이 경우는 서버 간 호출(프론트엔드 ->
 * 백엔드)이며 그 경로는 project secret으로 따로 인증합니다.
 */
const CSRF_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const ALLOWED_ORIGINS = new Set(
  [config.project.url, config.project.api].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  ),
);

const toOrigin = (value?: string): string | null => {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

// 요청이 밝힌 출처입니다. 브라우저가 아니면 null입니다.
const requestOrigin = (req: express.Request): string | null =>
  toOrigin(req.get("origin")) ?? toOrigin(req.get("referer"));

const isAllowedOrigin = (origin: string | null): boolean =>
  origin !== null && ALLOWED_ORIGINS.has(origin);

const forbiddenOrigin = (res: express.Response) => {
  res
    .status(403)
    .json(
      createErrorResponse(
        "failed",
        "Forbidden Origin",
        "Request origin is not allowed.",
      ),
    );
};

const csrfGuard = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  if (CSRF_SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  const origin = requestOrigin(req);
  if (origin === null || ALLOWED_ORIGINS.has(origin)) {
    next();
    return;
  }
  signale.warn(`Blocked cross-origin ${req.method} ${req.path} from ${origin}.`);
  forbiddenOrigin(res);
};

app.use(sessionMiddleware);
// 본문 크기 상한을 명시합니다. 기본값(100kb)에 의존하지 않고, 가장 큰 본문인
// 리플레이 로그를 담을 수 있는 선에서 고정합니다.
app.use(express.json({ limit: "512kb" }));
app.use(express.urlencoded({ extended: true, limit: "64kb" }));
app.use(cookieParser());
app.use(csrfGuard);

const gidVerify = async (token: string, clientId: string) => {
  const ticket = await gidClient.verifyIdToken({
    idToken: token,
    audience: clientId,
  });
  return ticket.getPayload();
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
  // 스케줄 콜백에서 던진 예외는 잡아 줄 호출자가 없어 그대로
  // unhandledRejection이 됩니다. 전체를 감싸 프로세스를 지킵니다.
  try {
    signale.info(new Date());
    signale.pending(`Updating rank history...`);
    const users = await knex("users")
      .select("userid", "rankHistory", "rating")
      .orderBy("rating", "desc");
    // 하루 한 번 rating 인덱스를 통째로 다시 만들어 증분 갱신에서 생길 수 있는
    // 누락을 바로잡습니다.
    await rebuildRatingIndex(users);
    for (let i = 0; i < users.length; i++) {
      // rankHistory가 손상된 사용자 한 명 때문에 작업 전체가 멈추지 않게 합니다.
      const previous = parseJson(users[i].rankHistory);
      const history = [...(Array.isArray(previous) ? previous : []), i + 1];
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
      // 순차 처리로 동시 실행 수를 1로 묶습니다. 유저 수만큼의 쿼리가
      // 한꺼번에 풀(max 7)로 몰리는 것을 막습니다.
      await observer(`${users[i].userid}`, "RANK", {
        rank100,
        rank50,
        rank10,
        rank1,
      });
    }
    signale.info(new Date());
    signale.success(`Rank history updated.`);
  } catch (err) {
    signale.error(`Failed to update rank history.`);
    signale.error(err);
  }
});

// 보관 기간이 지난 리플레이 로그를 매일 정리합니다. 플레이 1회당 파일 하나가
// 쌓이므로 정리 경로가 없으면 디스크가 차고, 그러면 서버 전체가 멈춥니다.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const cleanupLogs = schedule.scheduleJob("30 4 * * *", async () => {
  await cleanupReplayLogs();
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
      settings: JSON.stringify(defaultSettings()),
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

const TRACK_COLUMNS = [
  "name",
  "fileName",
  "producer",
  "bpm",
  "difficulty",
  "originalName",
];

const getAllTracks = () =>
  getOrSet(
    "tracks",
    keys.tracksAll(),
    () => knex("tracks").select(TRACK_COLUMNS),
    {
      cacheEmpty: false,
    },
  );

/**
 * 자유 입력 파라미터로 만들어지는 캐시 키의 개수를 실제 데이터 규모로 묶습니다.
 *
 * 캐시 키는 요청 파라미터를 그대로 사용하고 빈 결과도 저장하기 때문에, 검증이
 * 없으면 존재하지 않는 닉네임·곡 이름을 반복 조회하는 것만으로 Redis에 쓰레기
 * 키를 무제한 적재할 수 있었습니다. 형식 검증만으로는 부족합니다(닉네임 형식이
 * 허용하는 조합 자체가 사실상 무한하므로). 그래서 캐시 계층에 도달하기 전에
 * 대상이 실제로 존재하는지 확인합니다.
 *
 * 두 검사 모두 기존 캐시 키(tracks:all, pic:*)를 재사용하므로 정상 요청에서는
 * 추가 DB 조회가 발생하지 않고, 존재하지 않는 값은 cacheEmpty: false 때문에
 * 캐시에 남지 않습니다.
 */
const trackExists = async (fileName: string): Promise<boolean> => {
  const tracks = await getAllTracks();
  return tracks.some((track) => track.fileName === fileName);
};

const nicknameExists = async (nickname: string): Promise<boolean> => {
  const rows = await getOrSet(
    "profilePic",
    keys.profilePic(nickname),
    () => knex("users").select("picture").where("nickname", nickname),
    { cacheEmpty: false },
  );
  return rows.length > 0;
};

// 조회 대상이 없을 때 공통으로 쓰는 응답입니다.
const notFound = (res: express.Response, description: string) => {
  res
    .status(400)
    .json(createErrorResponse("failed", "Failed to Load", description));
};

app.get("/tracks", async (req, res) => {
  // 모든 페이지 진입마다 호출되지만 곡이 추가될 때만 바뀌는 데이터입니다.
  const results = await getAllTracks();
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
  if (!isValidFileName(filename)) {
    res
      .status(400)
      .json(
        createErrorResponse("failed", "Wrong Format", "Invalid track name."),
      );
    return;
  }
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
  // 기본 설정을 스키마 삼아 정규화합니다. 알 수 없는 키와 타입이 어긋난 값은
  // 버려지므로 저장되는 내용과 크기가 항상 고정됩니다.
  if (req.body.settings === undefined || req.body.settings === null) {
    res
      .status(400)
      .json(
        createErrorResponse("failed", "Wrong Request", "Missing settings."),
      );
    return;
  }
  const settings = normalizeSettings(req.body.settings);
  try {
    await knex("users")
      .update({ settings: JSON.stringify(settings) })
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

// /profile/:element의 요소별 인가 정책입니다.
// - "user"  : 본인 세션으로 바꿀 수 있는 값(장착 칭호·배너 표시 여부)입니다.
//             내부 서비스도 secret을 제시하면 대신 수행할 수 있습니다.
// - "service": 프론트엔드 이미지 업로드 파이프라인만 설정할 수 있는 값입니다.
//             NSFW 판정 결과(explicit)와 함께 들어와야 하므로 세션만으로는 허용하지 않습니다.
const PROFILE_ELEMENT_POLICY: Record<string, "user" | "service"> = {
  alias: "user",
  banner: "user",
  background: "service",
  picture: "service",
};

app.put("/profile/:element", async (req, res) => {
  const policy = PROFILE_ELEMENT_POLICY[req.params.element];
  if (!policy) {
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

  // 신원과 신뢰 수준을 분기 이전에 한 번만 확정합니다.
  // 예전에는 첫 가드가 secret의 "존재 여부"만 확인하고 값 검증은 background/picture
  // 분기 안에서만 했기 때문에, alias/banner는 아무 문자열이나 secret으로 보내면
  // 미인증 상태로 임의 userid를 지정할 수 있었습니다.
  const hasValidSecret = isValidSecret(req.body.secret);
  const isService = hasValidSecret && typeof req.body.userid === "string";
  const userid: string | undefined = req.session.userid
    ? req.session.userid
    : isService
      ? req.body.userid
      : undefined;

  if (!userid) {
    res
      .status(401)
      .json(
        createErrorResponse(
          "failed",
          "Unauthorized",
          "Login or a valid project secret is required for this task.",
        ),
      );
    return;
  }

  // service 전용 요소는 세션 로그인만으로는 변경할 수 없습니다.
  if (policy === "service" && !hasValidSecret) {
    res
      .status(403)
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
        const ownedAlias = parseJson<number[]>(users[0].ownedAlias) ?? [];
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
        // secret 검증은 라우트 진입부의 인가 단계에서 이미 끝났습니다.
        // background explicit = 비트 1(값 2)
        explicit = req.body.explicit ? explicit | 2 : explicit & ~2;
        await knex("users")
          .update({ background: req.body.value, explicit })
          .where("userid", userid);
        break;
      case "picture":
        // picture explicit = 비트 0(값 1)
        explicit = req.body.explicit ? explicit | 1 : explicit & ~1;
        await knex("users")
          .update({ picture: req.body.value, explicit })
          .where("userid", userid);
        break;
      case "banner": {
        // 배너는 가시성 토글((-) 마커)만 허용합니다. 소유 목록 자체는 변경할 수 없습니다.
        const submitted: unknown =
          typeof req.body.value === "string"
            ? parseJson(req.body.value)
            : req.body.value;
        const owned = parseJson<string[]>(users[0].banner) ?? [];
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
  // 난이도 선택은 1부터 시작하는 작은 정수입니다. 이 값은 캐시 그룹 키에도
  // 쓰이므로 범위를 고정합니다.
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
    // 검증이 끝난 값만 기록 저장 계층으로 직접 넘깁니다.
    // (이전에는 localhost로 자기 자신을 HTTP 재호출했습니다.)
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

app.get("/record/:index", async (req, res) => {
  // 프로필의 최근 플레이 10건이 한꺼번에 호출합니다. isBest/rating은 이후 플레이로
  // 바뀔 수 있어 짧은 TTL만 적용하고 별도 무효화는 하지 않습니다.
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

// 한 유저의 곡별 최고 기록을 한 번에 돌려줍니다.
// 곡 선택 화면이 트랙 수만큼 /record/:filename/:nickname을 호출하던 것을
// 요청 한 번으로 대체합니다.
app.get("/trackRecords/:nickname", async (req, res) => {
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
      // 곡 이름을 키로 묶습니다. 각 배열은 /record/:filename/:nickname과 동일하게
      // 난이도 내림차순입니다.
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

// 프로필의 최근 플레이 목록입니다. 클라이언트가 recentPlay의 id마다
// /record/:index를 호출하던 것을 요청 한 번으로 대체합니다.
app.get("/recentPlays/:uid", async (req, res) => {
  const uid = req.params.uid;
  const results = await getOrSet("record", keys.recentPlays(uid), async () => {
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
    // recentPlay는 최신순이므로, whereIn이 흐트러뜨린 순서를 되돌립니다.
    const byIndex = new Map(rows.map((row) => [row.index, row]));
    return indexes
      .map((index) => byIndex.get(index))
      .filter((row) => row !== undefined);
  });
  if (results === null) {
    res
      .status(400)
      .json(
        createErrorResponse("failed", "Failed to Load", "Cannot find user."),
      );
    return;
  }
  res.status(200).json({ result: "success", results });
});

app.get("/record/:filename/:nickname", async (req, res) => {
  // 곡별 단건 조회입니다. 곡 선택 화면은 /trackRecords/:nickname을 쓰지만,
  // 기존 클라이언트를 위해 유지합니다.
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
  // 미플레이 곡의 빈 결과까지 캐싱하는 경로이므로, 존재하지 않는 조합으로
  // 캐시가 부풀지 않도록 실재 여부를 먼저 확인합니다.
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

    const { fileName, nickname } = req.params;
    // 캐시 키를 이루는 나머지 파라미터도 형식을 고정합니다.
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
    // 기록이 없으면 null을 반환합니다. getOrSet은 null을 저장하지 않으므로,
    // 존재하지 않는 닉네임을 반복 조회해 순위 캐시 키를 늘리는 것을 막습니다.
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
    // 기록이 없는 경우의 응답값(0)은 기존 클라이언트와 동일하게 유지합니다.
    res.status(200).json({ result: "success", results, rank: rank ?? 0 });
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
    // 코드는 DB 조회 조건으로 쓰이므로 문자열만 허용합니다.
    // 객체/배열이 들어오면 knex가 의도치 않은 조건을 만들 수 있습니다.
    const code = req.body.code;
    if (typeof code !== "string" || !code.length || code.length > 64) {
      res
        .status(400)
        .json(
          createErrorResponse("failed", "Invalid code", "Invalid code sent."),
        );
      return;
    }
    try {
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
        // usedUser는 NULL이거나 "null"일 수 있습니다. 예전에는 조회 시에만
        // 방어하고 아래 push에서는 그대로 호출해, nolimit 쿠폰의 첫 사용에서
        // TypeError로 500이 나고 해당 쿠폰이 영구히 사용 불가가 되었습니다.
        const parsedUsedUser = parseJson(coupon.usedUser);
        const usedUser: string[] = Array.isArray(parsedUsedUser)
          ? parsedUsedUser
          : [];
        if (usedUser.indexOf(userid) != -1) {
          throw new CouponError(
            "Used code",
            "The code sent has already been used.",
          );
        }
        const reward = parseJson<{
          type?: string;
          content?: string;
          nolimit?: boolean;
        }>(coupon.reward);
        // 보상 정의가 깨져 있으면 캐치되지 않는 예외 대신 명확한 오류로 끝냅니다.
        if (!reward || typeof reward !== "object") {
          throw new CouponError("Invalid code", "Invalid code sent.");
        }
        if (reward.type == "skin") {
          const statusArr = await trx("users")
            .select("skins")
            .where("userid", userid)
            .forUpdate();
          if (!statusArr.length) {
            throw new CouponError("Invalid user", "Cannot find user.");
          }
          const parsedSkins = parseJson(statusArr[0].skins);
          const skins: string[] = Array.isArray(parsedSkins) ? parsedSkins : [];
          if (typeof reward.content !== "string") {
            throw new CouponError("Invalid code", "Invalid code sent.");
          }
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

/**
 * 세션을 저장소에서 지우고 쿠키도 회수합니다.
 *
 * 이전에는 세션 필드만 delete하고 저장했기 때문에, 인증 상태는 풀리더라도
 * 세션 레코드가 만료(14일)까지 Redis에 그대로 남고 브라우저의 쿠키도 남았습니다.
 */
const destroySession = (
  req: express.Request,
  res: express.Response,
  done: () => void,
) => {
  req.session.destroy((err) => {
    if (err) signale.error(err);
    res.clearCookie("urlate", {
      domain: config.session.domain,
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax",
      path: "/",
    });
    done();
  });
};

// 권장 경로입니다. 상태를 바꾸므로 POST이며 csrfGuard의 보호를 받습니다.
app.post("/auth/logout", (req, res) => {
  destroySession(req, res, () => {
    res.status(200).json(createSuccessResponse("success"));
  });
});

/**
 * 최상위 내비게이션으로 로그아웃하고 프론트엔드로 되돌아가는 경로입니다.
 * GET이라 csrfGuard가 적용되지 않으므로, 여기서는 출처를 직접 확인합니다.
 * 이 검사가 없으면 <img src="...auth/logout">만으로 남의 세션을 끊을 수
 * 있습니다(로그아웃 CSRF). 정상적인 이동은 항상 프론트엔드에서 시작되므로
 * Origin이나 Referer가 신뢰 목록과 일치합니다.
 */
app.get("/auth/logout", (req, res) => {
  if (!isAllowedOrigin(requestOrigin(req))) {
    forbiddenOrigin(res);
    return;
  }
  destroySession(req, res, () => {
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

/**
 * 서버를 기동합니다.
 *
 * Redis 연결을 listen() 콜백 안에서 시작하면, 연결이 맺어지기 전에 들어온
 * 요청이 세션 저장소 오류로 500이 되거나 캐시 없이 DB를 직접 때립니다.
 * 연결을 먼저 맺고 나서 포트를 엽니다.
 */
const start = async () => {
  await redisClient.connect().catch((err) => {
    // Redis가 없어도 캐시/rate limit은 DB 폴백으로 동작하므로 기동은 계속합니다.
    signale.error("Failed to connect to redis on startup.");
    signale.error(err);
  });

  // 기동 직후 rating 인덱스를 준비해 첫 프로필 조회부터 ZSET을 쓰도록 합니다.
  rebuildRatingIndexIfNeeded().catch((err) => signale.error(err));

  const server = app.listen(config.project.port, () => {
    signale.info(new Date());
    signale.success(`API Server running at port ${config.project.port}.`);
  });

  /**
   * 배포·재시작 시 진행 중인 요청을 끝까지 처리하고 자원을 정리합니다.
   * 정리 없이 종료하면 처리 중이던 요청이 끊기고, 커밋되지 않은 트랜잭션이
   * DB 쪽 타임아웃까지 잠금을 붙든 채 남습니다.
   */
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    signale.pending(`Received ${signal}, shutting down...`);

    // 새 연결을 받지 않고 진행 중인 요청이 끝나기를 기다립니다.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // 예약된 작업이 종료 중에 새 쿼리를 시작하지 않도록 멈춥니다.
    await schedule.gracefulShutdown().catch((err) => signale.error(err));
    await knex.destroy().catch((err) => signale.error(err));
    await redisClient.quit().catch((err) => signale.error(err));

    signale.success("Shutdown complete.");
    process.exit(0);
  };

  // 기다려도 끝나지 않으면 강제로 종료합니다(pm2의 kill_timeout보다 짧게).
  const SHUTDOWN_TIMEOUT_MS = 10000;
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      setTimeout(() => {
        signale.error("Shutdown timed out, forcing exit.");
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS).unref();
      shutdown(signal).catch((err) => {
        signale.error(err);
        process.exit(1);
      });
    });
  }
};

start().catch((err) => {
  signale.fatal("Failed to start the server.");
  signale.fatal(err);
  process.exit(1);
});
