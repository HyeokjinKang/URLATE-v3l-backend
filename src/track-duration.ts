import signale from "signale";

import config from "./config";
import { isRedisReady, redisClient } from "./redis";

const FETCH_TIMEOUT_MS = 5000;
const HEAD_BYTES = 4096;
const TAIL_BYTES = 65536;
const CACHE_TTL_SEC = 24 * 60 * 60;

/** Every bitrate on the CDN is encoded from the same source, so any one gives the length. */
const TRACK_RES = "192kbps";

const cacheKey = (fileName: string) => `trackDurationMs:${fileName}`;

const OGG_CAPTURE = Buffer.from("OggS");
const VORBIS_ID = Buffer.from("\x01vorbis", "latin1");

/** Sample rate from the Vorbis identification header in the first Ogg page. */
export const vorbisSampleRate = (head: Buffer): number | null => {
  const at = head.indexOf(VORBIS_ID);
  if (at < 0 || at + 16 > head.length) return null;
  const rate = head.readUInt32LE(at + 12);
  return rate > 0 ? rate : null;
};

const EOS_FLAG = 0x04;

/** Granule position (samples) of the end-of-stream Ogg page in the buffer. */
export const lastGranule = (tail: Buffer): number | null => {
  let at = tail.lastIndexOf(OGG_CAPTURE);
  while (at >= 0) {
    if (
      at + 14 <= tail.length &&
      tail[at + 4] === 0 &&
      (tail[at + 5] & EOS_FLAG) !== 0
    ) {
      const granule = tail.readBigInt64LE(at + 6);
      return granule > 0n ? Number(granule) : null;
    }
    at = at > 0 ? tail.lastIndexOf(OGG_CAPTURE, at - 1) : -1;
  }
  return null;
};

const fetchRange = async (url: string, range: string) => {
  const response = await fetch(url, {
    headers: {
      Range: range,
      Referer: `${new URL(config.project.url).origin}/`,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status !== 206 && response.status !== 200) {
    throw new Error(`Track ${url} responded ${response.status}.`);
  }
  return Buffer.from(await response.arrayBuffer());
};

export const fetchTrackDurationMs = async (fileName: string) => {
  const url = `${config.project.cdn}/tracks/${TRACK_RES}/${fileName}.ogg`;
  const [head, tail] = await Promise.all([
    fetchRange(url, `bytes=0-${HEAD_BYTES - 1}`),
    fetchRange(url, `bytes=-${TAIL_BYTES}`),
  ]);
  const rate = vorbisSampleRate(head);
  const granule = lastGranule(tail);
  if (!rate || !granule) return null;
  return Math.round((granule / rate) * 1000);
};

/** Song length in ms from the audio file itself, cached in Redis. null when it can't be read. */
export const getTrackDurationMs = async (
  fileName: string,
): Promise<number | null> => {
  if (isRedisReady()) {
    try {
      const cached = Number(await redisClient.get(cacheKey(fileName)));
      if (cached > 0) return cached;
    } catch (err) {
      signale.error(err);
    }
  }
  let duration: number | null;
  try {
    duration = await fetchTrackDurationMs(fileName);
  } catch (err) {
    signale.error(err);
    return null;
  }
  if (duration && isRedisReady()) {
    await redisClient
      .set(cacheKey(fileName), `${duration}`, { EX: CACHE_TTL_SEC })
      .catch((err) => signale.error(err));
  }
  return duration;
};
