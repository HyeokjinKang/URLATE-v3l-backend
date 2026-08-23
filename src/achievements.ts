import fetch from "node-fetch";
import signale from "signale";

import config from "./config";
import { knex } from "./db";
import { getOrSet, invalidate, keys } from "./cache";
import { parseJson } from "./validate";

// Kept short since this is a real-time notification.
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

// TODO: EZPZ and MID_GAP achievements aren't implemented yet.
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

// Does the actual achievement processing; exceptions are absorbed by observer below.
const runObserver = async (userid: string, context: string, data?: Data) => {
  const userData = await knex("users")
    .select("achievements", "ownedAlias", "banner", "alias")
    .where("userid", userid);
  if (!userData.length) {
    signale.debug(`Achievement observer got unknown userid ${userid}.`);
    return;
  }
  const achievements = new Set(
    parseJson<number[]>(userData[0].achievements) ?? [],
  );

  const index: number[] = await achievedIndex(context, data);

  // RANK reprocesses every achievement to keep aliases in sync, but only
  // notifies for the newly unlocked ones.
  let filteredIndex: number[];
  let newAchievements: number[];

  if (context === "RANK") {
    filteredIndex = index;
    newAchievements = index.filter((e) => !achievements.has(e));
  } else {
    filteredIndex = index.filter((e) => !achievements.has(e));
    newAchievements = filteredIndex;
  }

  // RANK reclaims a title when a player drops out, so it reaches the alias
  // adjustment below even with an empty list.
  if (context !== "RANK" && !filteredIndex.length) return;

  const achievementsList: Array<Achievement> = [];
  for (const i of newAchievements) {
    knex("achievements")
      .where("index", i)
      .increment("count")
      .catch((err: Error) => signale.error(err));
    achievements.add(i);
    // TODO: Find more elegant way to get i18n-ed data
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
    // Rank-related aliases are IDs 8-11.
    ownedAlias.delete(8);
    ownedAlias.delete(9);
    ownedAlias.delete(10);
    ownedAlias.delete(11);
    if (index.includes(idDB.TOP_1)) ownedAlias.add(11);
    else if (index.includes(idDB.TOP_10)) ownedAlias.add(10);
    else if (index.includes(idDB.TOP_50)) ownedAlias.add(9);
    else if (index.includes(idDB.TOP_100)) ownedAlias.add(8);
    if (!ownedAlias.has(selectedAlias)) {
      // pop() returns undefined on an empty set, which knex would reject with
      // "Undefined binding" -- fall back to the default title (0).
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
        // Not implemented yet.
      } else if (reward[0] === "banner") {
        if (typeof reward[1] === "string") banner.add(reward[1]);
      }
    }
  }

  const updated = {
    achievements: JSON.stringify(Array.from(achievements)),
    ownedAlias: JSON.stringify(Array.from(ownedAlias)),
    banner: JSON.stringify(Array.from(banner)),
    alias: selectedAlias,
  };

  // The daily rank job calls this for every user, so skip the write and cache
  // invalidation when nothing actually changed.
  const unchanged =
    updated.achievements ===
      JSON.stringify(parseJson<number[]>(userData[0].achievements) ?? []) &&
    updated.ownedAlias ===
      JSON.stringify(parseJson<number[]>(userData[0].ownedAlias) ?? []) &&
    updated.banner ===
      JSON.stringify(parseJson<string[]>(userData[0].banner) ?? []) &&
    updated.alias === userData[0].alias;
  if (unchanged && !achievementsList.length) return;

  if (!unchanged) {
    await knex("users")
      .update(updated)
      .where("userid", userid)
      .catch((err: Error) => {
        signale.error(err);
      });

    await invalidate(keys.profile(userid), keys.user(userid));
  }

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
      // node-fetch has no default timeout: an unresponsive game server would
      // leave the promise open and the socket held.
      signal: AbortSignal.timeout(GAME_SERVER_TIMEOUT_MS),
    }).catch((err) => {
      signale.error(err);
    });
  }
};

// Never rejects, so callers can skip await/.catch. Runs outside the request
// flow, where a leaked exception would end the process via unhandledRejection.
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
