import express from "express";
import signale from "signale";
import { OAuth2Client, type TokenPayload } from "google-auth-library";

import {
  createSuccessResponse,
  createErrorResponse,
  createStatusResponse,
} from "../api-response";
import { getOrSet, invalidate, keys } from "../cache";
import config from "../config";
import { knex } from "../db";
import {
  forbiddenOrigin,
  isAllowedOrigin,
  requestOrigin,
} from "../middleware/csrf";
import { rateLimit } from "../middleware/rate-limit";
import { isProduction } from "../middleware/session";
import { isBlockedNickname } from "../nickname-policy";
import { setRating } from "../rating-index";
import { defaultSettings } from "../settings";
import { isValidNickname } from "../validate";

const gidClient = new OAuth2Client(config.google.clientId);

export const router = express.Router();

const gidVerify = async (token: string, clientId: string) => {
  const ticket = await gidClient.verifyIdToken({
    idToken: token,
    audience: clientId,
  });
  return ticket.getPayload();
};

/**
 * 가입할 때 저장한 이메일을 구글이 방금 준 값으로 맞춥니다.
 *
 * 구글이 계정 대표 이메일 변경을 지원하면서 저장해 둔 주소가 낡을 수 있습니다.
 * 계정 식별자인 sub는 주소가 바뀌어도 그대로이므로 이를 기준으로 갱신합니다.
 *
 * 검증되지 않은 주소는 반영하지 않습니다. 구글은 소유가 확인되지 않은 주소도
 * payload에 실어 보내므로, 그대로 저장하면 남의 주소가 계정에 붙을 수 있습니다.
 *
 * 갱신에 실패해도 로그인은 막지 않습니다. 로그인 판별은 sub로만 하고 이메일은
 * 부가 정보라, 실패하면 다음 로그인에서 다시 맞추면 됩니다.
 */
const syncEmail = async (payload: TokenPayload) => {
  if (!payload.sub || !payload.email || payload.email_verified !== true) return;

  try {
    // <=>는 NULL 안전 비교입니다. 일반 <>를 쓰면 저장된 값이 NULL일 때 비교가
    // 참이 되지 않아, 이메일이 비어 있는 계정은 영영 갱신되지 않습니다.
    const changed = await knex("users")
      .where("userid", payload.sub)
      .whereRaw("NOT (email <=> ?)", [payload.email])
      .update({ email: payload.email });

    // 주소 자체는 남기지 않습니다. 로그로 새어 나갈 이유가 없습니다.
    if (changed > 0) signale.info(`Email updated : ${payload.sub}`);
  } catch (err) {
    signale.error(err);
  }
};

router.get("/auth/status", async (req, res) => {
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

router.post(
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
        // 세션에 담기 전에 맞춥니다. 가입은 세션의 이메일을 그대로 넣으므로,
        // 순서가 뒤바뀌면 갱신 직후 가입한 계정에 낡은 주소가 남습니다.
        await syncEmail(payload);

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

router.post("/auth/join", async (req, res) => {
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

  // 문자열 검사가 빠지면 RegExp.test가 인자를 문자열로 바꿔 검사합니다.
  // displayName을 아예 보내지 않으면 "undefined"(영숫자 9자)가 되어 통과합니다.
  const displayName = req.body.displayName;
  if (!isValidNickname(displayName)) {
    res
      .status(400)
      .json(
        createErrorResponse("failed", "Wrong Format", "Wrong name format."),
      );
    return;
  }

  // 형식은 맞지만 쓸 수 없는 이름입니다(예약어·욕설).
  if (isBlockedNickname(displayName)) {
    res.status(400).json(
      createErrorResponse(
        "failed",
        // 어느 목록에 걸렸는지는 알리지 않습니다.
        "Reserved Name",
        "The name sent cannot be used.",
      ),
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
    .where("nickname", displayName);
  if (!results[0]) {
    try {
      await knex("users").insert({
        nickname: displayName,
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
router.post("/auth/logout", (req, res) => {
  destroySession(req, res, () => {
    res.status(200).json(createSuccessResponse("success"));
  });
});

/**
 * 최상위 내비게이션으로 로그아웃하고 프론트엔드로 돌아가는 경로입니다.
 * GET이라 csrfGuard가 적용되지 않으므로 출처를 직접 확인합니다. 이 검사가
 * 없으면 <img src="...auth/logout">만으로 남의 세션을 끊을 수 있습니다.
 */
router.get("/auth/logout", (req, res) => {
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
