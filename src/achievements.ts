import fetch from "node-fetch";
import signale from "signale";

import config from "./config";
import { knex } from "./db";
import { getOrSet, invalidate, keys } from "./cache";
import { parseJson } from "./validate";

// 게임 서버 알림 호출의 상한입니다. 실시간 알림이므로 짧게 잡습니다.
const GAME_SERVER_TIMEOUT_MS = 3000;

interface Data {
  [key: string]: string | number | boolean | undefined;
}

interface Achievement {
  title_ko: string;
  title_en: string;
  detail_ko: string;
  detail_en: string;
  rewards: string;
}

const idDB = {
  TUTORIAL_CLEAR: 0,
  ONE_MISS: 1,
  ONE_BAD: 2,
  ONE_GOOD: 3,
  ONE_GREAT: 4,
  ALL_PERFECT: 5,
  FULL_COMBO: 6,
  ALL_ONE: 7,
  EZPZ: 8,
  MID_GAP: 9,
  ALL_HARD: 10,
  TOP_100: 11,
  TOP_50: 12,
  TOP_10: 13,
  TOP_1: 14,
};

//TODO: EZPZ, 미드차이, 이건 좀 무섭네요
const achievedIndex = async (context: string, data?: Data) => {
  const index: Array<number> = [];
  switch (context) {
    case "TUTORIAL_CLEAR":
      index.push(idDB.TUTORIAL_CLEAR);
      break;
    case "JUDGE":
      if (!data) {
        signale.debug("Achievement context JUDGE needs data.");
        break;
      }
      data.medal = Number(data.medal);
      if (data.medal == 7) index.push(idDB.ALL_PERFECT);
      if (data.medal - 2 >= 0) {
        // FC
        index.push(idDB.FULL_COMBO);
        if (data.good == 1 && data.great == 0) index.push(idDB.ONE_GOOD);
        else if (data.good == 0 && data.great == 1) index.push(idDB.ONE_GREAT);
      }
      if (
        data.miss == 1 &&
        data.bad == 1 &&
        data.good == 1 &&
        data.great == 1 &&
        data.bullet == 1
      )
        index.push(idDB.ALL_ONE);
      if (data.good == 0 && data.great == 0) {
        if (
          ((data.miss == 1 && data.bullet == 0) ||
            (data.miss == 0 && data.bullet == 1)) &&
          data.bad == 0
        )
          index.push(idDB.ONE_MISS);
        else if (data.miss == 0 && data.bullet == 0 && data.bad == 1)
          index.push(idDB.ONE_BAD);
      }
      break;
    case "RANK":
      if (!data) {
        signale.debug("Achievement context RANK needs data.");
        break;
      }
      if (data.rank1) index.push(idDB.TOP_1);
      if (data.rank10) index.push(idDB.TOP_10);
      if (data.rank50) index.push(idDB.TOP_50);
      if (data.rank100) index.push(idDB.TOP_100);
      break;
    default:
      signale.debug(`Achievement context ${context} is not defined.`);
  }
  return index;
};

/**
 * 업적 처리 본체입니다.
 *
 * 이 함수는 요청 처리 흐름 밖에서 fire-and-forget으로 호출되므로, 여기서 던진
 * 예외는 라우트의 try/catch나 Express 에러 핸들러에 잡히지 않고 그대로
 * unhandledRejection이 됩니다(Node 15+ 기본 동작은 프로세스 종료). 그래서
 * 아래 observer가 전체를 감싸 반드시 자체적으로 흡수합니다.
 */
const runObserver = async (userid: string, context: string, data?: Data) => {
  // 필요한 컬럼만 읽습니다(기존에는 users 행 전체를 SELECT 했습니다).
  const userData = await knex("users")
    .select("achievements", "ownedAlias", "banner", "alias")
    .where("userid", userid);
  if (!userData.length) {
    signale.debug(`Achievement observer got unknown userid ${userid}.`);
    return;
  }
  // JSON 컬럼이 손상되어 있어도 업적 처리가 통째로 실패하지 않도록 방어합니다.
  const achievements = new Set(
    parseJson<number[]>(userData[0].achievements) ?? [],
  );

  // Get achievement index array from data. It will be [] if there is no achievement.
  const index: number[] = await achievedIndex(context, data);

  // For RANK context, we need to process all achievements to update aliases,
  // but only send notifications for new achievements
  let filteredIndex: number[];
  let newAchievements: number[];

  if (context === "RANK") {
    filteredIndex = index;
    newAchievements = index.filter((e) => !achievements.has(e));
  } else {
    filteredIndex = index.filter((e) => !achievements.has(e));
    newAchievements = filteredIndex;
  }

  // Return early only if there's nothing to process at all
  // For RANK context, continue even if newAchievements is empty (to update aliases)
  if (!filteredIndex.length) return;

  const achievementsList: Array<Achievement> = [];
  for (const i of newAchievements) {
    // Achieved!
    knex("achievements")
      .where("index", i)
      .increment("count")
      .catch((err: Error) => signale.error(err));
    achievements.add(i);
    // TODO: Find more elegant way to get i18n-ed data
    // 업적 메타데이터는 사실상 불변이므로 캐싱해 기록 제출 경로의 조회를 줄입니다.
    const achievement = await getOrSet<Achievement[]>(
      "achievements",
      keys.achievement(i),
      () =>
        knex("achievements")
          .select("title_ko", "title_en", "detail_ko", "detail_en", "rewards")
          .where("index", i),
    );
    achievementsList.push(achievement[0]);
  }

  // Reward
  const ownedAlias = new Set(parseJson<number[]>(userData[0].ownedAlias) ?? []);
  const banner = new Set(parseJson<string[]>(userData[0].banner) ?? []);
  let selectedAlias = userData[0].alias;
  if (context === "RANK") {
    // Rank 관련 alias는 8~11번입니다.
    ownedAlias.delete(8);
    ownedAlias.delete(9);
    ownedAlias.delete(10);
    ownedAlias.delete(11);
    if (index.includes(idDB.TOP_1)) ownedAlias.add(11);
    else if (index.includes(idDB.TOP_10)) ownedAlias.add(10);
    else if (index.includes(idDB.TOP_50)) ownedAlias.add(9);
    else if (index.includes(idDB.TOP_100)) ownedAlias.add(8);
    if (!ownedAlias.has(selectedAlias)) {
      // 소유 목록이 비면 pop()이 undefined를 돌려주고, 그대로 UPDATE에 넘기면
      // knex가 "Undefined binding"으로 실패합니다. 기본 칭호(0)로 되돌립니다.
      selectedAlias = Array.from(ownedAlias).pop() ?? 0;
    }
  }
  for (const achievement of achievementsList) {
    const rewards = parseJson<[string, string | number][]>(achievement.rewards);
    if (!Array.isArray(rewards)) continue;
    for (const reward of rewards) {
      if (reward[0] === "alias" && context !== "RANK") {
        const aliasId = Number(reward[1]);
        if (Number.isInteger(aliasId)) ownedAlias.add(aliasId);
      } else if (reward[0] === "reward") {
        //not yet
      } else if (reward[0] === "banner") {
        if (typeof reward[1] === "string") banner.add(reward[1]);
      }
    }
  }

  // Update user data
  await knex("users")
    .update({
      achievements: JSON.stringify(Array.from(achievements)),
      ownedAlias: JSON.stringify(Array.from(ownedAlias)),
      banner: JSON.stringify(Array.from(banner)),
      alias: selectedAlias,
    })
    .where("userid", userid)
    .catch((err: Error) => {
      signale.error(err);
    });

  // 칭호·배너가 바뀌었으므로 프로필 캐시를 비웁니다.
  await invalidate(keys.profile(userid), keys.user(userid));

  // Send achievement data to game server only if there are new achievements
  if (achievementsList.length > 0) {
    fetch(`${config.project.game}/emit/achievement`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userid: userid,
        secret: config.project.secretKey,
        achievement: achievementsList,
      }),
      // node-fetch는 기본 타임아웃이 없습니다. 게임 서버가 응답하지 않으면
      // 이 프로미스가 영원히 열린 채 소켓을 점유하므로 상한을 둡니다.
      // 업적 알림은 실패해도 되는 부가 기능이라 그대로 흘려보냅니다.
      signal: AbortSignal.timeout(GAME_SERVER_TIMEOUT_MS),
    }).catch((err) => {
      signale.error(err);
    });
  }
};

/**
 * 업적 처리를 호출합니다. 실패해도 호출자의 흐름(기록 저장, 튜토리얼 완료 등)을
 * 되돌리지 않고 로그만 남깁니다. 어떤 경우에도 거부된 프로미스를 밖으로
 * 내보내지 않으므로 호출부에서 await나 .catch를 붙이지 않아도 안전합니다.
 */
export const observer = async (
  userid: string,
  context: string,
  data?: Data,
): Promise<void> => {
  try {
    await runObserver(userid, context, data);
  } catch (err) {
    signale.error(`Achievement observer failed for ${userid} (${context}).`);
    signale.error(err);
  }
};
