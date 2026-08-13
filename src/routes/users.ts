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
      // 1위 곡 수는 컬럼이 아니라 trackRecords에서 셉니다. 필드 이름은 유지합니다.
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

  // 순위는 Redis Sorted Set으로 계산합니다. 동점자 처리는 SQL COUNT와 동일합니다.
  const rating = Number(results[0].rating);
  let higher = await countHigherRating(rating);
  if (higher === null) {
    // 인덱스가 없으면 DB로 폴백하고 배경에서 채웁니다.
    const [row] = await knex("users")
      .where("rating", ">", rating)
      .count({ higher: "*" });
    higher = Number(row.higher);
    rebuildRatingIndexIfNeeded().catch((err) => signale.error(err));
  }
  const rank = higher + 1;

  res.status(200).json({ result: "success", user: results[0], rank });
};

/**
 * 닉네임으로 조회하는 공개 프로필입니다. 순위표에서 넘어오는 경로가 여기이며,
 * 남의 프로필을 보기 위해 내부 식별자(userid)를 알 필요가 없습니다.
 *
 * 닉네임을 userid로 바꾼 뒤 아래 /profile/:uid와 같은 캐시 항목을 씁니다.
 * 별도 키를 두면 프로필을 무효화하는 모든 경로가 두 키를 함께 지워야 합니다.
 */
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
