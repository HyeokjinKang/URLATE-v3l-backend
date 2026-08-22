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
  // Clamp limit to 1-100 to prevent excessive queries.
  const limit = Math.min(
    Math.max(toFiniteNonNegInt(req.params.limit) ?? 0, 1),
    100,
  );
  let results;
  try {
    // Any limit is just a prefix of the same sorted result, so the top 100 is
    // cached once and sliced per request.
    const top = await getOrSet("ranking", keys.ranking(sort), () =>
      knex("users")
        // userid (the Google sub) isn't used for displaying rank; profiles
        // are looked up by nickname, so there's no reason to send an
        // internal identifier for 100 users.
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
