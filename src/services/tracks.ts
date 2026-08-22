import { getOrSet, keys } from "../cache";
import { knex } from "../db";

export const TRACK_COLUMNS = [
  "name",
  "fileName",
  "producer",
  "bpm",
  "difficulty",
  "originalName",
];

export const getAllTracks = () =>
  getOrSet(
    "tracks",
    keys.tracksAll(),
    () => knex("tracks").select(TRACK_COLUMNS),
    {
      cacheEmpty: false,
    },
  );

/**
 * Checks whether a target actually exists before it reaches the cache layer.
 * Cache keys are built directly from request parameters and empty results
 * are stored too, so repeatedly querying nonexistent values alone would pile
 * up junk keys in Redis indefinitely. The nickname format allows effectively
 * unlimited combinations, so format validation alone isn't enough.
 *
 * Both checks reuse existing cache keys, so a normal request incurs no extra lookup.
 */
export const trackExists = async (fileName: string): Promise<boolean> => {
  const tracks = await getAllTracks();
  return tracks.some((track) => track.fileName === fileName);
};

export const nicknameExists = async (nickname: string): Promise<boolean> => {
  const rows = await getOrSet(
    "profilePic",
    keys.profilePic(nickname),
    () => knex("users").select("picture").where("nickname", nickname),
    { cacheEmpty: false },
  );
  return rows.length > 0;
};

/**
 * Resolves a nickname to the internal identifier. Bridges the gap between
 * the public API, which takes a nickname, and the cache, which is keyed on
 * userid. There's no rename path, so this mapping never changes and is safe
 * to cache for a long time.
 */
export const useridOf = async (nickname: string): Promise<string | null> => {
  const rows = await getOrSet(
    "authStatus",
    keys.useridByNickname(nickname),
    () => knex("users").select("userid").where("nickname", nickname),
    { cacheEmpty: false },
  );
  return rows.length ? String(rows[0].userid) : null;
};
