import express from "express";
import signale from "signale";

import { createErrorResponse } from "../api-response";
import { MIRAI_FEED_MAX, MiraiFeed, miraiFeed } from "../services/mirai";
import { NOTICE_LANGS, toFiniteNonNegInt } from "../validate";

export const router = express.Router();

const FEED_DEFAULT = 5;

const rejectLang = (res: express.Response) => {
  res
    .status(400)
    .json(
      createErrorResponse("failed", "Wrong Format", "Unsupported language."),
    );
};

const reportFailure = (res: express.Response, err: unknown) => {
  signale.error(err);
  res
    .status(500)
    .json(
      createErrorResponse(
        "failed",
        "Error occurred while loading",
        "Failed to load from MIRAI.",
      ),
    );
};

const respondWithFeed = async (
  req: express.Request,
  res: express.Response,
  feed: MiraiFeed,
  lang: string,
) => {
  if (!NOTICE_LANGS.has(lang)) {
    rejectLang(res);
    return;
  }
  const limit = Math.min(
    Math.max(toFiniteNonNegInt(req.query.limit) ?? FEED_DEFAULT, 1),
    MIRAI_FEED_MAX,
  );

  let entries;
  try {
    entries = await miraiFeed(feed, lang);
  } catch (e) {
    reportFailure(res, e);
    return;
  }

  res.status(200).json({ result: "success", data: entries.slice(0, limit) });
};

router.get("/notices/:lang", (req, res) =>
  respondWithFeed(req, res, "announcements", req.params.lang),
);

router.get("/posts/:lang", (req, res) =>
  respondWithFeed(req, res, "blog", req.params.lang),
);
