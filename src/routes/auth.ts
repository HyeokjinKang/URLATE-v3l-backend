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

// Syncs the stored email to what Google returned at login. A primary email can
// change, so updates are keyed on sub, which stays fixed.
//
// Unverified addresses are never applied: Google includes addresses whose
// ownership isn't confirmed, and storing one would attach someone else's
// address to this account. A failure here never blocks login -- login is
// decided by sub alone, and email resyncs next time.
const syncEmail = async (payload: TokenPayload) => {
  if (!payload.sub || !payload.email || payload.email_verified !== true) return;

  try {
    // <=> is NULL-safe; plain <> would never match a stored NULL, so an account
    // with no email would never sync.
    const changed = await knex("users")
      .where("userid", payload.sub)
      .whereRaw("NOT (email <=> ?)", [payload.email])
      .update({ email: payload.email });

    // The address itself isn't logged; no reason for it to leak into logs.
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

  // Registration status only ever flips false -> true, so it's safe to cache for a long time.
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
      // audience is pinned to the server config value; the client-supplied clientId isn't trusted.
      const payload = await gidVerify(
        req.body.jwt.credential,
        config.google.clientId,
      );
      if (payload) {
        // Sync before writing to the session. Join copies the session's email
        // as-is, so doing this out of order would leave a stale address on an
        // account that just registered right after a sync.
        await syncEmail(payload);

        // Regenerate the session ID on successful auth to prevent session fixation.
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

  // Without the string check, RegExp.test coerces its argument: omitting
  // displayName becomes "undefined", 9 alphanumeric chars, and passes.
  const displayName = req.body.displayName;
  if (!isValidNickname(displayName)) {
    res
      .status(400)
      .json(
        createErrorResponse("failed", "Wrong Format", "Wrong name format."),
      );
    return;
  }

  // Well-formed but unusable (reserved words, profanity).
  if (isBlockedNickname(displayName)) {
    res.status(400).json(
      createErrorResponse(
        "failed",
        // Doesn't reveal which list the name matched.
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
    // Invalidate so the account shows as registered immediately.
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

// Removes the session from the store and clears the cookie.
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

// Preferred route; POST means csrfGuard covers it.
router.post("/auth/logout", (req, res) => {
  destroySession(req, res, () => {
    res.status(200).json(createSuccessResponse("success"));
  });
});

// Logs out via top-level navigation and returns to the frontend. csrfGuard
// doesn't cover GET, so the origin is checked directly -- otherwise an
// <img src="...auth/logout"> alone could end someone else's session.
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
