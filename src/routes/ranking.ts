import express from "express";
import signale from "signale";

import { createErrorResponse } from "../api-response";
import { getOrSet, keys } from "../cache";
import { knex } from "../db";
import { SORT_DIRECTIONS, toFiniteNonNegInt } from "../validate";

export const router = express.Router();

router.get("/ranking/:sort/:limit", async (req, res) => {
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
        // userid(구글 sub)는 순위 표시에 쓰이지 않습니다. 프로필은 닉네임으로
        // 조회하므로 내부 식별자를 100명분씩 내보낼 이유가 없습니다.
        .select(
          "nickname",
          "rating",
          "picture",
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
