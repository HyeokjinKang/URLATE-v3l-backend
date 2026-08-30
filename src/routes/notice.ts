import express from "express";
import { XMLParser } from "fast-xml-parser";
import fetch from "node-fetch";
import signale from "signale";

import { createErrorResponse } from "../api-response";
import { getOrSet, keys } from "../cache";
import config from "../config";
import { NOTICE_LANGS, toFiniteNonNegInt } from "../validate";

export const router = express.Router();

// The longest list a caller may ask for, and the number cached per language.
const NOTICES_MAX = 20;
const NOTICES_DEFAULT = 5;

// node-fetch has no default timeout: an unresponsive MIRAI would leave the
// promise open and the socket held.
const FEED_TIMEOUT_MS = 5000;

const MIRAI_URL = config.project.mirai ?? "https://mirai.urlate.coupy.dev";

// MIRAI is a Docusaurus site whose default locale is English, so English is
// served from the root and every other locale from its own path prefix. Must
// match the i18n block in its docusaurus.config.js.
const MIRAI_DEFAULT_LOCALE = "en";

const feedUrl = (lang: string) =>
  lang === MIRAI_DEFAULT_LOCALE
    ? `${MIRAI_URL}/announcements/rss.xml`
    : `${MIRAI_URL}/${lang}/announcements/rss.xml`;

interface Notice {
  date: string;
  title: string;
  url: string;
}

interface FeedItem {
  title?: unknown;
  link?: unknown;
  pubDate?: unknown;
}

// parseTagValue would turn an all-digit title into a number; every field here
// is text, so the conversion is only a way to be surprised later.
const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false });

// Announcement titles are written as "2025.05.17. | Something happened", and
// the date is returned separately, so the prefix is dropped rather than shown
// twice by every client. A title without one is left alone.
const TITLE_DATE_PREFIX =
  /^\s*\d{4}[.\-/]\s*\d{1,2}[.\-/]\s*\d{1,2}\.?\s*\|\s*/;

const toNotice = (item: FeedItem): Notice | null => {
  if (typeof item.title !== "string" || typeof item.link !== "string") {
    return null;
  }
  const date = new Date(String(item.pubDate));
  if (Number.isNaN(date.getTime())) return null;

  const title = item.title.replace(TITLE_DATE_PREFIX, "").trim();
  if (!title) return null;

  return { date: date.toISOString(), title, url: item.link };
};

/**
 * The announcements MIRAI publishes for one language, newest first.
 *
 * They used to be typed into a database table by hand, which meant the site and
 * the game could disagree about what the latest announcement was. The feed is
 * generated from the same posts the site serves, so there is only one copy.
 */
const fetchNotices = async (lang: string): Promise<Notice[]> => {
  const response = await fetch(feedUrl(lang), {
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`MIRAI feed responded ${response.status}.`);
  }

  const parsed = parser.parse(await response.text());
  // A feed holding a single entry parses to one object rather than a list.
  const items: unknown = parsed?.rss?.channel?.item;
  const list: FeedItem[] = Array.isArray(items)
    ? items
    : items
      ? [items as FeedItem]
      : [];

  return list
    .map(toNotice)
    .filter((notice): notice is Notice => notice !== null)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, NOTICES_MAX);
};

// Also keeps a burst of players from turning into a burst of feed requests.
const cachedNotices = (lang: string) =>
  getOrSet("notice", keys.notices(lang), () => fetchNotices(lang));

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
        "Failed to load announcements.",
      ),
    );
};

/**
 * Kept for clients that predate /notices. The response shape is the one they
 * already parse, per-language column names and all.
 */
router.get("/notice/:lang", async (req, res) => {
  if (!NOTICE_LANGS.has(req.params.lang)) {
    rejectLang(res);
    return;
  }
  const lang = req.params.lang;

  let notices;
  try {
    notices = await cachedNotices(lang);
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

/**
 * The most recent announcements, newest first.
 *
 * An empty feed is a 200 with an empty list: "nothing has been posted" is an
 * answer, not a failure, and a caller rendering a list has nothing to recover
 * from.
 */
router.get("/notices/:lang", async (req, res) => {
  if (!NOTICE_LANGS.has(req.params.lang)) {
    rejectLang(res);
    return;
  }
  const lang = req.params.lang;
  const limit = Math.min(
    Math.max(toFiniteNonNegInt(req.query.limit) ?? NOTICES_DEFAULT, 1),
    NOTICES_MAX,
  );

  let notices;
  try {
    // Any limit is just a prefix of the same ordered list, so the longest one
    // is cached once per language and sliced per request.
    notices = await cachedNotices(lang);
  } catch (e) {
    reportFailure(res, e);
    return;
  }

  res.status(200).json({ result: "success", data: notices.slice(0, limit) });
});
