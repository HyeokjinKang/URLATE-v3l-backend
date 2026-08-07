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
 * 캐시 계층에 닿기 전에 대상의 실재 여부를 확인합니다. 캐시 키는 요청 파라미터를
 * 그대로 쓰고 빈 결과도 저장하므로, 없는 값을 반복 조회하는 것만으로 Redis에
 * 쓰레기 키가 무한히 쌓입니다. 닉네임 형식이 허용하는 조합이 사실상 무한해
 * 형식 검증만으로는 부족합니다.
 *
 * 두 검사 모두 기존 캐시 키를 재사용하므로 정상 요청에는 추가 조회가 없습니다.
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
