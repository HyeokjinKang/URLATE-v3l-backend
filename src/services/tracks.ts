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

// Existence check before the cache layer. Cache keys come straight from request
// parameters and empty results are stored, so querying nonexistent values would
// pile up junk keys indefinitely -- and the nickname format allows effectively
// unlimited combinations. Both checks reuse existing keys, so a normal request
// incurs no extra lookup.
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

// Bridges the public API, which takes a nickname, and the cache, which is keyed
// on userid. There's no rename path, so this mapping is safe to cache long.
export const useridOf = async (nickname: string): Promise<string | null> => {
  const rows = await getOrSet(
    "authStatus",
    keys.useridByNickname(nickname),
    () => knex("users").select("userid").where("nickname", nickname),
    { cacheEmpty: false },
  );
  return rows.length ? String(rows[0].userid) : null;
};
