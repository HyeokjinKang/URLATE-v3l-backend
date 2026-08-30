import { XMLParser } from "fast-xml-parser";
import fetch from "node-fetch";

import { CacheKind, getOrSet, keys } from "../cache";
import config from "../config";

/**
 * MIRAI publishes two Docusaurus blogs: announcements, and the longer-form
 * posts on the site root. Both are read through their generated RSS feeds, so
 * what the game shows is always what the site shows.
 */
export type MiraiFeed = "announcements" | "blog";

export interface MiraiEntry {
  date: string;
  title: string;
  url: string;
}

// The most entries kept per feed. Every caller asks for a prefix of this.
export const MIRAI_FEED_MAX = 20;

// node-fetch has no default timeout: an unresponsive MIRAI would leave the
// promise open and the socket held.
const FEED_TIMEOUT_MS = 5000;

const MIRAI_URL = config.project.mirai ?? "https://mirai.urlate.coupy.dev";

// MIRAI's default locale is English, so English is served from the root and
// every other locale from its own path prefix. Must match the i18n block in its
// docusaurus.config.js.
const MIRAI_DEFAULT_LOCALE = "en";

// The announcements blog is mounted on its own route; the other one is the site
// root, which is why its path is empty.
const FEED_PATHS: Record<MiraiFeed, string> = {
  announcements: "/announcements",
  blog: "",
};

// Separate buckets so the two can be tuned apart in config.
const FEED_CACHE_KINDS: Record<MiraiFeed, CacheKind> = {
  announcements: "notice",
  blog: "posts",
};

const feedUrl = (feed: MiraiFeed, lang: string) => {
  const locale = lang === MIRAI_DEFAULT_LOCALE ? "" : `/${lang}`;
  return `${MIRAI_URL}${locale}${FEED_PATHS[feed]}/rss.xml`;
};

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
// twice by every client. A title without one -- every blog post, for instance
// -- is left alone.
const TITLE_DATE_PREFIX =
  /^\s*\d{4}[.\-/]\s*\d{1,2}[.\-/]\s*\d{1,2}\.?\s*\|\s*/;

const toEntry = (item: FeedItem): MiraiEntry | null => {
  if (typeof item.title !== "string" || typeof item.link !== "string") {
    return null;
  }
  const date = new Date(String(item.pubDate));
  if (Number.isNaN(date.getTime())) return null;

  const title = item.title.replace(TITLE_DATE_PREFIX, "").trim();
  if (!title) return null;

  return { date: date.toISOString(), title, url: item.link };
};

const fetchFeed = async (
  feed: MiraiFeed,
  lang: string,
): Promise<MiraiEntry[]> => {
  const response = await fetch(feedUrl(feed, lang), {
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`MIRAI ${feed} feed responded ${response.status}.`);
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
    .map(toEntry)
    .filter((entry): entry is MiraiEntry => entry !== null)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, MIRAI_FEED_MAX);
};

/**
 * One feed's entries for one language, newest first. Cached, which also keeps a
 * burst of players from turning into a burst of requests to MIRAI.
 */
export const miraiFeed = (feed: MiraiFeed, lang: string) =>
  getOrSet(FEED_CACHE_KINDS[feed], keys.miraiFeed(feed, lang), () =>
    fetchFeed(feed, lang),
  );
