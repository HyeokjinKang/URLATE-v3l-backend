import fetch from "node-fetch";
import { URLATEConfig } from "./types/config.schema";

interface idDB {
  [key: string]: number;
}

const idDB: idDB = {
  TUTORIAL_CLEAR: 0,
};

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

const isAchieved = (context: string, data?: object) => {
  switch (context) {
    case "TUTORIAL_CLEAR":
      return true;
    default:
      return false;
  }
};

export const observer = async (
  userid: string,
  context: string,
  data?: object
) => {
  const userData = await knex("users")
    .select("achievements")
    .where("userid", userid);
  const index = idDB[context];
  let achievements: Set<number> = new Set(JSON.parse(userData[0].achievements));
  if (achievements.has(index) || !isAchieved(context, data)) return;
  achievements.add(index);
  await knex("achievements").where("index", index).increment("count");
  const achievementsData = await knex("achievements")
    .select("title_ko", "title_en", "detail_ko", "detail_en", "rewards")
    .where("index", index);
  await fetch(`${config.project.game}/emit/achievement`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      userid: userid,
      secret: config.project.secretKey,
      achievement: achievementsData[0],
    }),
  });
  await knex("users")
    .where("userid", userid)
    .update({ achievements: JSON.stringify(Array.from(achievements)) });
};
