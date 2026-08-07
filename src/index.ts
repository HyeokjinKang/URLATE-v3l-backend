import cookieParser from "cookie-parser";
import express from "express";
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
import { scheduleJobs } from "./jobs";
import { rebuildRatingIndexIfNeeded } from "./services/rating-bootstrap";
import {
  getAllTracks,
  nicknameExists,
  trackExists,
} from "./services/tracks";
import { notFound } from "./respond";
import { isProduction, sessionMiddleware } from "./middleware/session";
import {
  csrfGuard,
  forbiddenOrigin,
  isAllowedOrigin,
  requestOrigin,
} from "./middleware/csrf";
import { requireLogin } from "./middleware/require-login";
import { rateLimit } from "./middleware/rate-limit";
import { ensureBody, securityHeaders } from "./middleware/headers";
import { errorHandler, notFoundHandler } from "./middleware/errors";
import { countFirstPlaces, submitRecord } from "./record";
import { writeReplayLog } from "./replay-log";
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
import { countHigherRating, setRating } from "./rating-index";

import { defaultSettings, normalizeSettings } from "./settings";

// Node 15+는 처리되지 않은 프로미스 거부에서 프로세스를 종료합니다.
process.on("unhandledRejection", (reason) => {
  signale.error("Unhandled promise rejection:");
  signale.error(reason);
});

// uncaughtException 이후의 상태는 신뢰할 수 없어 pm2 재시작에 맡깁니다.
process.on("uncaughtException", (err) => {
  signale.fatal("Uncaught exception, shutting down:");
  signale.fatal(err);
  process.exit(1);
});

const gidClient = new OAuth2Client(config.google.clientId);

const app = express();
app.locals.pretty = true;

// 버전 노출을 막습니다.
app.disable("x-powered-by");

// HTTPS를 종단하는 프록시 뒤이므로 X-Forwarded-Proto를 신뢰해야 secure 쿠키가 동작합니다.
app.set("trust proxy", 1);

app.use(securityHeaders);

// 차단될 요청이 세션 조회와 본문 파싱 비용을 치르지 않도록 앞에 둡니다.
app.use(rateLimit({ windowSec: 60, max: 600, prefix: "global" }));

app.use(sessionMiddleware);
// 가장 큰 본문인 리플레이 로그를 담을 수 있는 선으로 고정합니다(기본값은 100kb).
app.use(express.json({ limit: "512kb" }));
app.use(express.urlencoded({ extended: true, limit: "64kb" }));
app.use(cookieParser());

app.use(ensureBody);

app.use(csrfGuard);

const gidVerify = async (token: string, clientId: string) => {
  const ticket = await gidClient.verifyIdToken({
    idToken: token,
    audience: clientId,
  });
  return ticket.getPayload();
};

app.get("/auth/status", async (req, res) => {
  const userid = req.session.userid;
  if (!userid) {
    res.status(200).json(createStatusResponse("Not logined"));
    return;
  }

  // 가입 여부는 한번 참이 되면 되돌아가지 않아 길게 캐싱해도 안전합니다.
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
      // audience는 서버 설정값으로 고정합니다(클라이언트 clientId 불신).
      const payload = await gidVerify(
        req.body.jwt.credential,
        config.google.clientId,
      );
      if (payload) {
        // 세션 고정 방지를 위해 인증 성공 시 세션 ID를 재발급합니다.
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

  const registered = await knex("users")
    .select("userid")
    .where("userid", req.session.userid)
    .first();
  if (registered) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Already Registered",
          "You are already registered.",
        ),
      );
    return;
  }

  const results = await knex("users")
    .select("nickname")
    .where("nickname", req.body.displayName);
  if (!results[0]) {
    try {
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
    } catch (err) {
      if ((err as { code?: string }).code === "ER_DUP_ENTRY") {
        res
          .status(400)
          .json(
            createErrorResponse(
              "failed",
              "Duplicated",
              "Already registered, or the name sent already exists.",
            ),
          );
        return;
      }
      throw err;
    }
    // 가입 즉시 로그인 상태로 보이도록 비웁니다.
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

app.get("/user", requireLogin, async (req, res) => {
  const userid = req.session.userid as string;

  // 본인 데이터이므로 키에 userid를 포함해 유저 간 교차 노출을 막습니다.
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
    async () => {
      const rows = await knex("users")
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
          "ap",
          "fc",
          "clear",
          "ownedAlias",
          "explicit",
        )
        .where("userid", uid);
      if (!rows.length) return rows;
      // 1위 곡 수는 컬럼이 아니라 trackRecords에서 셉니다. 필드 이름은 유지합니다.
      rows[0]["1stNum"] = await countFirstPlaces(rows[0].nickname);
      return rows;
    },
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

  // 순위는 Redis Sorted Set으로 계산합니다. 동점자 처리는 SQL COUNT와 동일합니다.
  const rating = Number(results[0].rating);
  let higher = await countHigherRating(rating);
  if (higher === null) {
    // 인덱스가 없으면 DB로 폴백하고 배경에서 채웁니다.
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
  // 페이지 진입마다 호출되지만 곡이 추가될 때만 바뀝니다.
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
  // 곡을 고를 때마다 호출되지만 패턴이 갱신될 때만 바뀝니다.
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

app.put("/settings", requireLogin, async (req, res) => {
  const userid = req.session.userid as string;
  // 기본 설정을 스키마 삼아 정규화합니다. 알 수 없는 키와 타입 불일치는 버려집니다.
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

// 요소별 인가 정책입니다.
// - user   : 본인 세션 또는 유효한 secret으로 변경 가능
// - service: 유효한 secret 필수. NSFW 판정 결과와 함께 들어와야 하므로 세션만으로는 불가
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

  // 신원과 신뢰 수준은 분기 이전에 한 번만 확정합니다. 분기 안에서 따로
  // 검증하면 빠뜨린 분기가 그대로 인가 우회가 됩니다.
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
    // explicit 비트필드입니다(2=background, 1=picture).
    let explicit = Number(users[0].explicit);
    switch (req.params.element) {
      case "alias": {
        // 소유한 칭호만 장착할 수 있습니다.
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
        // secret 검증은 진입부에서 끝났습니다.
        explicit = req.body.explicit ? explicit | 2 : explicit & ~2;
        await knex("users")
          .update({ background: req.body.value, explicit })
          .where("userid", userid);
        break;
      case "picture":
        explicit = req.body.explicit ? explicit | 1 : explicit & ~1;
        await knex("users")
          .update({ picture: req.body.value, explicit })
          .where("userid", userid);
        break;
      case "banner": {
        // 가시성 토글((-) 마커)만 허용하고 소유 목록은 바꿀 수 없습니다.
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
    // 변경이 곧바로 보이도록 비웁니다.
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

app.put("/tutorial", requireLogin, async (req, res) => {
  const userid = req.session.userid as string;
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

app.put("/playRecord", requireLogin, async (req, res) => {
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

app.get("/record/:index", async (req, res) => {
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
    // whereIn이 흐트러뜨린 순서를 recentPlay의 최신순으로 되돌립니다.
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
      // 응답은 10건만 쓰므로 DB에서부터 잘라 옵니다.
      .limit(10),
  );
  res.status(200).json({ result: "success", results });
});

app.get(
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

app.put(
  "/coupon",
  rateLimit({ windowSec: 300, max: 30, prefix: "coupon" }),
  requireLogin,
  async (req, res) => {
    // 검증 실패를 트랜잭션 롤백과 함께 전달하기 위한 타입입니다.
    class CouponError extends Error {
      constructor(
        public error: string,
        public description: string,
      ) {
        super(description);
      }
    }

    const userid = req.session.userid as string;
    // 객체/배열이 들어오면 knex가 의도치 않은 조회 조건을 만듭니다.
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
      // 같은 코드의 동시 사용을 직렬화하기 위해 트랜잭션 + 행 잠금으로 처리합니다.
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
        // usedUser는 NULL이거나 "null"일 수 있습니다.
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
        // 보상 정의가 깨져 있으면 명확한 오류로 끝냅니다.
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

// 세션을 저장소에서 지우고 쿠키도 회수합니다.
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

// 권장 경로입니다. POST라 csrfGuard의 보호를 받습니다.
app.post("/auth/logout", (req, res) => {
  destroySession(req, res, () => {
    res.status(200).json(createSuccessResponse("success"));
  });
});

/**
 * 최상위 내비게이션으로 로그아웃하고 프론트엔드로 돌아가는 경로입니다.
 * GET이라 csrfGuard가 적용되지 않으므로 출처를 직접 확인합니다. 이 검사가
 * 없으면 <img src="...auth/logout">만으로 남의 세션을 끊을 수 있습니다.
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
  // 컬럼명 조합에 쓰이므로 화이트리스트로 제한합니다.
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

app.use(notFoundHandler);

app.use(errorHandler);

// Redis 연결을 기다리는 상한입니다. node-redis는 무한히 재시도하므로 그대로
// await하면 Redis가 죽어 있는 동안 포트가 아예 열리지 않습니다.
const REDIS_CONNECT_TIMEOUT_MS = 5000;

// Redis 연결을 닫습니다.
const closeRedis = async () => {
  try {
    // 재연결 중인 클라이언트는 isOpen이 true여도 quit()이 정착하지 않으므로
    // isReady일 때만 시도합니다.
    if (redisClient.isReady) {
      await Promise.race([
        redisClient.quit(),
        // unref()를 쓰면 안 됩니다. 남은 핸들이 모두 unref면 타이머가 발화하기
        // 전에 프로세스가 빠져나가 종료 절차가 중간에 끊깁니다.
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
  } catch (err) {
    signale.error(err);
  }
  try {
    if (redisClient.isOpen) redisClient.destroy();
  } catch {
    // 이미 닫혀 있습니다.
  }
};

const start = async () => {
  const connecting = redisClient.connect().catch((err) => {
    // Redis가 없어도 DB 폴백으로 동작하므로 기동은 계속합니다.
    signale.error("Failed to connect to redis on startup.");
    signale.error(err);
  });
  await Promise.race([
    connecting,
    new Promise<void>((resolve) =>
      setTimeout(resolve, REDIS_CONNECT_TIMEOUT_MS).unref(),
    ),
  ]);
  if (!redisClient.isReady) {
    signale.warn(
      "Starting without redis. Cache and rate limit fall back until it recovers.",
    );
  }

  // 첫 프로필 조회부터 ZSET을 쓰도록 미리 준비합니다.
  rebuildRatingIndexIfNeeded().catch((err) => signale.error(err));

  scheduleJobs();

  const server = app.listen(config.project.port, () => {
    signale.info(new Date());
    signale.success(`API Server running at port ${config.project.port}.`);
  });

  // 배포·재시작 시 진행 중인 요청을 끝내고 자원을 정리합니다. 정리 없이
  // 종료하면 커밋되지 않은 트랜잭션이 DB 타임아웃까지 잠금을 붙듭니다.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    signale.pending(`Received ${signal}, shutting down...`);

    // 새 연결을 막고 진행 중인 요청을 기다립니다.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // 종료 중에 예약 작업이 새 쿼리를 시작하지 않도록 멈춥니다.
    await schedule.gracefulShutdown().catch((err) => signale.error(err));
    await knex.destroy().catch((err) => signale.error(err));
    await closeRedis();

    signale.success("Shutdown complete.");
    process.exit(0);
  };

  // 끝나지 않으면 강제 종료합니다. pm2의 kill_timeout보다 짧아야 합니다.
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
