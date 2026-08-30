import express from "express";
import signale from "signale";

import { createErrorResponse } from "../api-response";
import { getOrSet, keys } from "../cache";
import { knex } from "../db";
import { NOTICE_LANGS, toFiniteNonNegInt } from "../validate";

export const router = express.Router();

// The longest list a caller may ask for, and the number cached per language.
const NOTICES_MAX = 20;
const NOTICES_DEFAULT = 5;

const rejectLang = (res: express.Response) => {
  res
    .status(400)
    .json(
      createErrorResponse("failed", "Wrong Format", "Unsupported language."),
    );
};

router.get("/notice/:lang", async (req, res) => {
  // Used to build column names, so restricted to a whitelist.
  if (!NOTICE_LANGS.has(req.params.lang)) {
    rejectLang(res);
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

/**
 * The most recent announcements, newest first. The language is already in the
 * path, so the per-language columns are returned under plain names.
 *
 * An empty table is a 200 with an empty list: "nothing has been posted" is an
 * answer, not a failure, and a caller rendering a list has nothing to recover
 * from.
 */
router.get("/notices/:lang", async (req, res) => {
  // Used to build column names, so restricted to a whitelist.
  if (!NOTICE_LANGS.has(req.params.lang)) {
    rejectLang(res);
    return;
  }
  const lang = req.params.lang;
  const limit = Math.min(
    Math.max(toFiniteNonNegInt(req.query.limit) ?? NOTICES_DEFAULT, 1),
    NOTICES_MAX,
  );

  let results;
  try {
    // Any limit is just a prefix of the same ordered list, so the longest one
    // is cached once per language and sliced per request.
    const recent = await getOrSet("notice", keys.notices(lang), () =>
      knex("notice")
        .select("date", `title_${lang} as title`, `url_${lang} as url`)
        .orderBy("date", "desc")
        .limit(NOTICES_MAX),
    );
    results = recent.slice(0, limit);
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

  res.status(200).json({ result: "success", data: results });
});
