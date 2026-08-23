import express from "express";

import { createErrorResponse } from "../api-response";
import { getOrSet, keys } from "../cache";
import { knex } from "../db";
import { NOTICE_LANGS } from "../validate";

export const router = express.Router();

router.get("/notice/:lang", async (req, res) => {
  // Used to build column names, so restricted to a whitelist.
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
