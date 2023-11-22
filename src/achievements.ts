import fetch from "node-fetch";
import { URLATEConfig } from "./types/config.schema";
import signale from "signale";

const config: URLATEConfig = require(__dirname + "/../config/config.json");

const knex = require("knex")({
  client: "mysql",
  connection: {
    host: config.database.host,
    user: config.database.user,
    password: config.database.password,
    database: config.database.db,
  },
  pool: { min: 0, max: 7 },
});

interface Data {
  [key: string]: string | number | undefined;
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
};

const achievedIndex = async (context: string, data?: Data) => {
  let index: Array<number> = [];
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
        index.push(6);
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
    default:
      signale.debug(`Achievement context ${context} is not defined.`);
  }
  return index;
};

export const observer = async (
  userid: string,
  context: string,
  data?: Data
) => {
  const userData = await knex("users")
    .select("achievements")
    .where("userid", userid);
  let achievements: Set<number> = new Set(JSON.parse(userData[0].achievements));

  // Get achievement index array from data. It will be [] if there is no achievement.
  const index: Array<number> = await achievedIndex(context, data);
  const filteredIndex = index.filter((e) => !achievements.has(e));
  if (!filteredIndex.length) return;

  let achievementsList: Array<object> = [];
  for (const i of filteredIndex) {
    // Achieved!
    knex("achievements").where("index", i).increment("count");
    achievements.add(i);
    // TODO: Find more elegance way to get i18n-ed data
    const achievement = await knex("achievements")
      .select("title_ko", "title_en", "detail_ko", "detail_en", "rewards")
      .where("index", i);
    achievementsList.push(achievement[0]);
  }

  // Update user data
  await knex("users")
    .update({ achievements: JSON.stringify(Array.from(achievements)) })
    .where("userid", userid)
    .catch((err: Error) => {
      signale.error(err);
    });

  // Send achievement data to game server
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
  }).catch((err) => {
    signale.error(err);
  });
};
