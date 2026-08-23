import express from "express";
import signale from "signale";

import { observer } from "../achievements";
import { createSuccessResponse, createErrorResponse } from "../api-response";
import { getOrSet, invalidate, keys } from "../cache";
import { knex } from "../db";
import { requireLogin } from "../middleware/require-login";
import { countHigherRating } from "../rating-index";
import { countFirstPlaces } from "../record";
import { isValidSecret } from "../secret";
import { rebuildRatingIndexIfNeeded } from "../services/rating-bootstrap";
import { useridOf } from "../services/tracks";
import { normalizeSettings } from "../settings";
import { isValidNickname, parseJson } from "../validate";

export const router = express.Router();

router.get("/user", requireLogin, async (req, res) => {
  const userid = req.session.userid as string;

  // Keyed by userid to prevent cross-exposure between users.
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

const PROFILE_COLUMNS = [
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
];

const loadProfile = (userid: string) =>
  getOrSet(
    "profile",
    keys.profile(userid),
    async () => {
      const rows = await knex("users")
        .select(PROFILE_COLUMNS)
        .where("userid", userid);
      if (!rows.length) return rows;
      // First-place count is computed from trackRecords, not a column; field name is kept as-is.
      rows[0]["1stNum"] = await countFirstPlaces(rows[0].nickname);
      return rows;
    },
    { cacheEmpty: false },
  );

const respondProfile = async (
  res: express.Response,
  results: Record<string, unknown>[],
) => {
  if (!results.length) {
    res
      .status(400)
      .json(
        createErrorResponse("failed", "Failed to Load", "Cannot find user."),
      );
    return;
  }

  // Rank is computed from a Redis Sorted Set; tie handling matches the SQL COUNT equivalent.
  const rating = Number(results[0].rating);
  let higher = await countHigherRating(rating);
  if (higher === null) {
    // Fall back to the DB if the index is missing, and rebuild it in the background.
    const [row] = await knex("users")
      .where("rating", ">", rating)
      .count({ higher: "*" });
    higher = Number(row.higher);
    rebuildRatingIndexIfNeeded().catch((err) => signale.error(err));
  }
  const rank = higher + 1;

  res.status(200).json({ result: "success", user: results[0], rank });
};

// Public profile by nickname, so the leaderboard can link to a profile without
// exposing the internal userid. Reuses /profile/:uid's cache entry; a separate
// key would force every profile-invalidating path to clear both.
router.get("/profile/nickname/:nickname", async (req, res) => {
  const nickname = req.params.nickname;
  if (!isValidNickname(nickname)) {
    res
      .status(400)
      .json(createErrorResponse("failed", "Wrong Format", "Invalid nickname."));
    return;
  }
  const userid = await useridOf(nickname);
  if (!userid) {
    res
      .status(400)
      .json(
        createErrorResponse("failed", "Failed to Load", "Cannot find user."),
      );
    return;
  }
  await respondProfile(res, await loadProfile(userid));
});

router.get("/profile/:uid", async (req, res) => {
  await respondProfile(res, await loadProfile(req.params.uid));
});

router.get("/profilePic/:username", async (req, res) => {
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

router.put("/settings", requireLogin, async (req, res) => {
  const userid = req.session.userid as string;
  // Normalized against the default settings as a schema; unknown keys dropped.
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

// Per-element authorization policy.
// - user   : changeable with the caller's own session or a valid secret
// - service: requires a valid secret. Must arrive together with an NSFW
//            classification result, so a session alone isn't enough.
const PROFILE_ELEMENT_POLICY: Record<string, "user" | "service"> = {
  alias: "user",
  banner: "user",
  background: "service",
  picture: "service",
};

router.put("/profile/:element", async (req, res) => {
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

  // Resolved once before branching; per-branch checks risk a bypass in any
  // branch that forgets one.
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

  // service-only elements can't be changed by session login alone.
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
    // explicit bitfield: 2=background, 1=picture.
    let explicit = Number(users[0].explicit);
    switch (req.params.element) {
      case "alias": {
        // Can only equip an alias the user actually owns.
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
        // Secret validation already happened above.
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
        // Only allows toggling visibility (the "(-)" marker); the owned set itself can't change.
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
    // Invalidate so the change shows up immediately.
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

router.put("/tutorial", requireLogin, async (req, res) => {
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

router.get("/teamProfile/:name", async (req, res) => {
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
