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
        "Error occured while loading",
        "Failed to load from MIRAI.",
      ),
    );
};

/**
 * A feed's entries, newest first.
 *
 * An empty feed is a 200 with an empty list: "nothing has been posted" is an
 * answer, not a failure, and a caller rendering a list has nothing to recover
 * from.
 */
const respondWithFeed = async (
  req: express.Request,
  res: express.Response,
  feed: MiraiFeed,
  lang: string,
) => {
  // Picks the locale path on MIRAI, so restricted to a whitelist.
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
    // Any limit is just a prefix of the same ordered list, so the longest one
    // is cached once per feed and language and sliced per request.
    entries = await miraiFeed(feed, lang);
  } catch (e) {
    reportFailure(res, e);
    return;
  }

  res.status(200).json({ result: "success", data: entries.slice(0, limit) });
};

/**
 * Kept for clients that predate /notices. The response shape is the one they
 * already parse, per-language field names and all.
 */
router.get("/notice/:lang", async (req, res) => {
  if (!NOTICE_LANGS.has(req.params.lang)) {
    rejectLang(res);
    return;
  }
  const lang = req.params.lang;

  let notices;
  try {
    notices = await miraiFeed("announcements", lang);
  } catch (e) {
    reportFailure(res, e);
    return;
  }

  if (!notices.length) {
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

  const latest = notices[0];
  res.status(200).json({
    result: "success",
    data: {
      date: latest.date,
      [`title_${lang}`]: latest.title,
      [`url_${lang}`]: latest.url,
    },
  });
});

/** The most recent announcements. */
router.get("/notices/:lang", (req, res) =>
  respondWithFeed(req, res, "announcements", req.params.lang),
);

/** The most recent blog posts, which are published apart from announcements. */
router.get("/posts/:lang", (req, res) =>
  respondWithFeed(req, res, "blog", req.params.lang),
);
