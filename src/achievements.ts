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
      return true;
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
  filteredIndex.forEach(async (i) => {
    // Achieved!
    knex("achievements").where("index", i).increment("count");
    achievements.add(i);
    // TODO: Find more elegance way to get i18n-ed data
    const achievement = await knex("achievements")
      .select("title_ko", "title_en", "detail_ko", "detail_en", "rewards")
      .where("index", i);
    achievementsList.push(achievement[0]);
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
  });

  // Update user data
  knex("users")
    .where("userid", userid)
    .update({ achievements: JSON.stringify(Array.from(achievements)) });
};
