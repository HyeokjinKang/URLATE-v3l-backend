/* eslint-disable @typescript-eslint/no-var-requires */
import * as bodyParser from "body-parser";
import * as session from "express-session";
import cookieParser from "cookie-parser";
import express from "express";
import mysqlSession from "express-mysql-session";
import signale from "signale";
import fetch from "node-fetch";
import { v4 } from "uuid";
const fs = require("fs-extra");
const { OAuth2Client } = require("google-auth-library");

import { URLATEConfig } from "./types/config.schema";
import {
  createSuccessResponse,
  createErrorResponse,
  createStatusResponse,
} from "./api-response";

const config: URLATEConfig = require(__dirname + "/../config/config.json");
const settingsConfig = require(__dirname + "/../config/settings.json");

const MySQLStore = mysqlSession(session);

const gidClient = new OAuth2Client(config.google.clientId);

const app = express();
app.locals.pretty = true;

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

const sessionStore = new MySQLStore({
  host: config.database.host,
  port: config.database.port,
  user: config.database.user,
  password: config.database.password,
  database: config.database.db,
});

app.use(
  session.default({
    secret: config.session.secret,
    store: sessionStore,
    resave: config.session.resave,
    saveUninitialized: config.session.saveUninitialized,
  })
);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());

async function gidVerify(token: String, clientId: String) {
  const ticket = await gidClient.verifyIdToken({
    idToken: token,
    audience: clientId,
  });
  return ticket.getPayload();
}

const uuid = () => {
  const tokens = v4().split("-");
  return tokens[2] + tokens[1] + tokens[0] + tokens[3] + tokens[4];
};

app.get("/auth/status", async (req, res) => {
  if (!req.session.userid) {
    res.status(200).json(createStatusResponse("Not logined"));
    return;
  }

  const results = await knex("users")
    .select("userid", "nickname")
    .where("userid", req.session.userid);
  if (!results[0]) {
    res
      .status(200)
      .json({ status: "Not registered", tempName: req.session.tempName });
    return;
  }

  res.status(200).json(createStatusResponse("Logined"));
});

app.post("/auth/login", async (req, res) => {
  try {
    const payload: any = await gidVerify(
      req.body.jwt.credential,
      req.body.jwt.clientId
    );
    req.session.userid = payload.sub;
    req.session.email = payload.email;
    req.session.picture = payload.picture;
    req.session.tempName = payload.name || payload.given_name || "Name";
    req.session.save(() => {
      signale.debug(new Date());
      signale.debug(`User logined : ${payload.email}`);
      res.status(200).json(createSuccessResponse("success"));
    });
  } catch (e: any) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Verification failed",
          "JWT Verification failed. Did you modify the JWT?"
        )
      );
  }
  return;
});

app.post("/auth/join", async (req, res) => {
  if (!req.session.userid) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Wrong Request",
          "You need to login first."
        )
      );
    return;
  }

  const namePattern = /^[a-zA-Z0-9_-]{5,12}$/;
  const isValidated = namePattern.test(req.body.displayName);
  if (!isValidated) {
    res
      .status(400)
      .json(
        createErrorResponse("failed", "Wrong Format", "Wrong name format.")
      );
    return;
  }

  const results = await knex("users")
    .select("nickname")
    .where("nickname", req.body.displayName);
  if (!results[0]) {
    await knex("users").insert({
      nickname: req.body.displayName,
      userid: req.session.userid,
      date: new Date(),
      email: req.session.email,
      settings: JSON.stringify(settingsConfig),
      skins: '["Default"]',
      tutorial: 3,
      picture: req.session.picture,
      background: "https://urlate-cdn.coupy.dev/albums/100/urlate.webp",
      alias: 0,
      rating: 0,
      rankHistory: "[]",
      banner: "[]",
      recentPlay: "[]",
      scoreSum: "0",
      accuracy: "0",
      playtime: 0,
      "1thNum": 0,
      ap: 0,
      fc: 0,
      clear: 0,
    });
    delete req.session.tempName;
    req.session.save(() => {
      res.status(200).json(createSuccessResponse("success"));
    });
  } else {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Exist Name",
          "The name sent already exists."
        )
      );
  }
});

app.get("/user", async (req, res) => {
  if (!req.session.userid) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "UserID Required",
          "UserID is required for this task."
        )
      );
    return;
  }

  const results = await knex("users")
    .select("nickname", "settings", "skins", "userid", "tutorial", "picture")
    .where("userid", req.session.userid);
  if (!results.length) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Failed to Load",
          "Failed to load data. Use /auth/status to check your status."
        )
      );
    return;
  }

  res.status(200).json({ result: "success", user: results[0] });
});

app.post("/user", async (req, res) => {
  if (!req.body.userid) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "UserID Required",
          "UserID is required for this task."
        )
      );
    return;
  }

  const results = await knex("users")
    .select("nickname", "settings")
    .where("userid", req.body.userid);
  if (!results.length) {
    res
      .status(400)
      .json(
        createErrorResponse("failed", "Failed to Load", "Failed to load data.")
      );
    return;
  }

  res.status(200).json({ result: "success", user: results[0] });
});

app.get("/profile/:uid", async (req, res) => {
  const results = await knex("users")
    .select(
      "nickname",
      "skins",
      "picture",
      "background",
      "alias",
      "rating",
      "rankHistory",
      "banner",
      "rank",
      "recentPlay",
      "scoreSum",
      "accuracy",
      "playtime",
      "1thNum",
      "ap",
      "fc",
      "clear"
    )
    .where("userid", req.params.uid);
  if (!results.length) {
    res
      .status(400)
      .json(
        createErrorResponse("failed", "Failed to Load", "Cannot find user.")
      );
    return;
  }

  res.status(200).json({ result: "success", user: results[0] });
});

app.get("/tracks", async (req, res) => {
  const results = await knex("tracks").select(
    "name",
    "fileName",
    "producer",
    "bpm",
    "difficulty",
    "originalName"
  );
  if (!results.length) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Failed to Load",
          "Failed to load tracks. It may be a problem with the DB."
        )
      );
    return;
  }

  res.status(200).json({ result: "success", tracks: results });
});

app.get("/track/:name", async (req, res) => {
  const results = await knex("tracks")
    .select("name", "fileName", "producer", "bpm", "difficulty", "originalName")
    .where("name", req.params.name);
  if (!results.length) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Failed to Load",
          "Failed to load track. It may be a problem with the DB."
        )
      );
    return;
  }

  res.status(200).json({ result: "success", track: results });
});

app.get("/trackInfo/:name", async (req, res) => {
  const results = await knex("patternInfo")
    .select("bpm", "bullet_density", "note_density", "speed")
    .where("name", req.params.name);
  if (!results.length) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Failed to Load",
          "Failed to load track data. It may be a problem with the DB."
        )
      );
    return;
  }
  res.status(200).json({ result: "success", info: results });
});

app.put("/settings", async (req, res) => {
  if (!req.session.userid) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "UserID Required",
          "UserID is required for this task."
        )
      );
    return;
  }
  try {
    await knex("users")
      .update({ settings: JSON.stringify(req.body.settings) })
      .where("userid", req.session.userid);
  } catch (e: any) {
    res
      .status(400)
      .json(createErrorResponse("failed", "Error occured while updating", e));
    return;
  }
  res.status(200).json(createSuccessResponse("success"));
});

app.put("/tutorial", async (req, res) => {
  if (!req.session.userid) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "UserID Required",
          "UserID is required for this task."
        )
      );
    return;
  }
  try {
    await knex("users")
      .update({ tutorial: 1 })
      .where("userid", req.session.userid);
  } catch (e: any) {
    res
      .status(400)
      .json(createErrorResponse("failed", "Error occured while updating", e));
    return;
  }
  res.status(200).json(createSuccessResponse("success"));
});

app.get("/skin/:skinName", async (req, res) => {
  const results = await knex("skins")
    .select("data")
    .where("name", req.params.skinName);
  if (!results.length) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Failed to Load",
          "Failed to load skin data."
        )
      );
    return;
  }
  res.status(200).json({ result: "success", data: results[0].data });
});

app.get("/teamProfile/:name", async (req, res) => {
  const results = await knex("teamProfiles")
    .select("data")
    .where("name", req.params.name);
  if (!results.length) {
    res
      .status(400)
      .json(
        createErrorResponse("failed", "Failed to Load", "Failed to load data.")
      );
    return;
  }
  res.status(200).json({ result: "success", data: results[0].data });
});

app.get("/trackCount/:name", async (req, res) => {
  res.end();
});

app.put("/playRecord", async (req, res) => {
  //doesn't scan the entire record yet
  //userid, username, rank, score, maxCombo, perfect, great, good, bad, miss, bullet, accuracy, record
  if (!req.session.userid) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "UserID Required",
          "UserID is required for this task."
        )
      );
    return;
  }

  const results = await knex("users")
    .select("nickname", "userid")
    .where("userid", req.session.userid);
  if (!results.length) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Failed to Load",
          "Failed to load data. Use /auth/status to check your status."
        )
      );
    return;
  }

  if (
    results[0].userid == req.body.userid &&
    results[0].username == req.body.username
  ) {
    const perfect = Number(req.body.perfect);
    const great = Number(req.body.great);
    const good = Number(req.body.good);
    const bad = Number(req.body.bad);
    const miss = Number(req.body.miss);
    const bullet = Number(req.body.bullet);
    let accuracy = Number(
      (
        ((perfect + (great / 10) * 7 + good / 2 + (bad / 10) * 3) /
          (perfect + great + good + bad + miss + bullet)) *
        100
      ).toFixed(1)
    );
    let rank = "";
    let medal = 1;
    if (accuracy >= 98 && bad == 0 && miss == 0 && bullet == 0) {
      rank = "SS";
    } else if (accuracy >= 95) {
      rank = "S";
    } else if (accuracy >= 90) {
      rank = "A";
    } else if (accuracy >= 80) {
      rank = "B";
    } else if (accuracy >= 70) {
      rank = "C";
    } else {
      rank = "F";
      medal = 0;
    }
    if (bad == 0 && miss == 0 && bullet == 0) {
      if (medal == 0) {
        medal = 2;
      } else {
        medal = 3;
      }
      if (bad == 0 && good == 0 && great == 0 && perfect != 0) {
        medal = 7;
      }
    }
    if (rank == req.body.rank && accuracy == req.body.accuracy) {
      fs.outputJson(
        `${__dirname}/../logs/${req.body.userName}/${
          req.body.name
        }/${new Date().toString()}.json`,
        req.body.record
      );
      fetch(`${config.project.api}/record`, {
        method: "PUT",
        body: JSON.stringify({
          secret: config.project.secretKey,
          name: req.body.name,
          nickname: req.body.userName,
          rank,
          record: req.body.score,
          maxcombo: req.body.maxCombo,
          medal,
          difficulty: req.body.difficulty,
          judge: `${perfect} / ${great} / ${good} / ${bad} / ${miss} / ${bullet}`,
        }),
        headers: {
          "Content-Type": "application/json",
        },
      })
        .then((res) => res.json())
        .then((data) => {
          if (data.result == "success") {
            res.status(200).json(createSuccessResponse("success"));
          } else {
            res
              .status(400)
              .json(
                createErrorResponse(
                  "failed",
                  "Failed to Update",
                  `Failed to update score. ${JSON.stringify(data.error)}`
                )
              );
          }
        })
        .catch((e) => {
          res
            .status(400)
            .json(
              createErrorResponse(
                "failed",
                "Failed to Update",
                `Failed to update score. ${e}`
              )
            );
          return;
        });
    } else {
      res
        .status(400)
        .json(
          createErrorResponse(
            "failed",
            "Failed to Verify",
            "Failed to verify submitted data."
          )
        );
      return;
    }
  } else {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Failed to Auth",
          "Failed to auth. Use /auth/status to check your status."
        )
      );
    return;
  }
});

app.put("/record", async (req, res) => {
  if (req.body.secret !== config.project.secretKey) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Authorize failed",
          "Project secret key is not vaild."
        )
      );
    return;
  }
  try {
    let isBest = 0;
    const result = await knex("trackRecords")
      .select("record")
      .where("nickname", req.body.nickname)
      .where("name", req.body.name)
      .where("isBest", 1)
      .where("difficulty", req.body.difficulty);
    if (result.length && result[0].record < req.body.record) {
      isBest = 1;
      await knex("trackRecords")
        .update({
          isBest: 0,
        })
        .where("nickname", req.body.nickname)
        .where("name", req.body.name)
        .where("isBest", 1)
        .where("difficulty", req.body.difficulty);
    }
    if (!result.length) isBest = 1;
    await knex("trackRecords").insert({
      name: req.body.name,
      nickname: req.body.nickname,
      rank: req.body.rank,
      record: req.body.record,
      maxcombo: req.body.maxcombo,
      medal: req.body.medal,
      difficulty: req.body.difficulty,
      date: new Date(),
      isBest: isBest,
      index: uuid(),
      judge: req.body.judge,
    });
  } catch (e: any) {
    res
      .status(400)
      .json(createErrorResponse("failed", "Error occured while updating", e));
    return;
  }
  res.status(200).json(createSuccessResponse("success"));
});

app.get("/record/:index", async (req, res) => {
  const results = await knex("trackRecords")
    .select(
      "rank",
      "record",
      "maxcombo",
      "medal",
      "difficulty",
      "date",
      "judge"
    )
    .where("index", req.params.index);
  if (!results.length) {
    res.status(200).json(createSuccessResponse("empty"));
    return;
  }
  res.status(200).json({ result: "success", results });
});

app.get("/record/:track/:name", async (req, res) => {
  const results = await knex("trackRecords")
    .select("rank", "record", "maxcombo", "medal", "difficulty", "date")
    .where("nickname", req.params.name)
    .where("name", req.params.track)
    .where("isBest", 1)
    .orderBy("difficulty", "DESC");
  if (!results.length) {
    res.status(200).json(createSuccessResponse("empty"));
    return;
  }
  res.status(200).json({ result: "success", results });
});

app.get(
  "/records/:track/:difficulty/:order/:sort/:nickname",
  async (req, res) => {
    const results = await knex("trackRecords")
      .select("rank", "record", "maxcombo", "nickname")
      .where("name", req.params.track)
      .where("difficulty", req.params.difficulty)
      .where("isBest", 1)
      .orderBy(req.params.order, req.params.sort);
    const rank =
      results
        .map((d: any) => {
          return d["nickname"];
        })
        .indexOf(req.params.nickname) + 1;
    res
      .status(200)
      .json({ result: "success", results: results.slice(0, 100), rank: rank });
  }
);

app.put("/coupon", async (req, res) => {
  if (!req.session.userid) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "UserID Required",
          "UserID is required for this task."
        )
      );
    return;
  }
  try {
    const code = req.body.code;
    const couponArr = await knex("codes")
      .select("reward", "used", "usedUser")
      .where("code", code);
    if (couponArr.length != 1) {
      res
        .status(400)
        .json(
          createErrorResponse("failed", "Invalid code", "Invalid code sent.")
        );
      return;
    }
    const coupon = couponArr[0];
    if (coupon.used) {
      res
        .status(400)
        .json(
          createErrorResponse(
            "failed",
            "Used code",
            "The code sent has already been used."
          )
        );
      return;
    }
    const usedUser = JSON.parse(coupon.usedUser);
    if (usedUser) {
      if (usedUser.indexOf(req.session.userid) != -1) {
        res
          .status(400)
          .json(
            createErrorResponse(
              "failed",
              "Used code",
              "The code sent has already been used."
            )
          );
        return;
      }
    }
    const reward = JSON.parse(coupon.reward);
    if (reward.type == "skin") {
      const statusArr = await knex("users")
        .select("skins")
        .where("userid", req.session.userid);
      const skins = JSON.parse(statusArr[0].skins);
      if (skins.indexOf(reward.content) != -1) {
        res
          .status(400)
          .json(
            createErrorResponse(
              "failed",
              "Already have",
              "User already has the skin."
            )
          );
        return;
      } else {
        skins.push(reward.content);
        await knex("users")
          .update({ skins: JSON.stringify(skins) })
          .where("userid", req.session.userid);
      }
    }
    if (!reward.nolimit) {
      await knex("codes").update({ used: 1 }).where("code", code);
    } else {
      usedUser.push(req.session.userid);
      await knex("codes")
        .update({ usedUser: JSON.stringify(usedUser) })
        .where("code", code);
    }
  } catch (e: any) {
    res
      .status(400)
      .json(createErrorResponse("failed", "Error occured while loading", e));
    return;
  }
  res.status(200).json(createSuccessResponse("success"));
});

app.get("/auth/logout", (req, res) => {
  delete req.session.userid;
  delete req.session.tempName;
  delete req.session.email;
  delete req.session.picture;
  req.session.save(() => {
    if (req.query.redirect == "true") {
      let adder = "";
      if (req.query.shutdowned == "true") adder = "/?shutdowned=true";
      res.redirect(config.project.url + adder);
    } else {
      res.status(200).json(createSuccessResponse("success"));
    }
  });
});

app.put("/CPLrecord", async (req, res) => {
  if (req.body.secret !== config.project.secretKey) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Authorize failed",
          "Project secret key is not vaild."
        )
      );
    return;
  }
  try {
    let isBest = 0;
    let gap = 0;
    const result = await knex("CPLtrackRecords")
      .select("record")
      .where("nickname", req.body.nickname)
      .where("name", req.body.name)
      .where("isBest", 1)
      .where("difficulty", req.body.difficulty)
      .where("id", req.body.id);
    if (result.length && result[0].record < req.body.record) {
      isBest = 1;
      gap = req.body.record - result[0].record;
      await knex("CPLtrackRecords")
        .update({
          isBest: 0,
        })
        .where("nickname", req.body.nickname)
        .where("name", req.body.name)
        .where("isBest", 1)
        .where("difficulty", req.body.difficulty)
        .where("id", req.body.id);
    }
    if (!result.length) {
      isBest = 1;
      gap = req.body.record;
    }
    await knex("CPLtrackRecords").insert({
      id: req.body.id,
      name: req.body.name,
      nickname: req.body.nickname,
      rank: req.body.rank,
      record: req.body.record,
      maxcombo: req.body.maxcombo,
      difficulty: req.body.difficulty,
      isBest: isBest,
    });
    const total = await knex("CPLTotalTrackRecords")
      .select("record")
      .where("nickname", req.body.nickname)
      .where("name", req.body.name)
      .where("difficulty", req.body.difficulty);
    const score = total[0].record + gap;
    if (total.length) {
      await knex("CPLTotalTrackRecords")
        .update({
          record: score,
        })
        .where("nickname", req.body.nickname)
        .where("name", req.body.name)
        .where("difficulty", req.body.difficulty);
    } else {
      await knex("CPLTotalTrackRecords").insert({
        name: req.body.name,
        nickname: req.body.nickname,
        record: req.body.record,
        difficulty: req.body.difficulty,
      });
    }
  } catch (e: any) {
    res
      .status(400)
      .json(createErrorResponse("failed", "Error occured while updating", e));
    return;
  }
  res.status(200).json(createSuccessResponse("success"));
});

app.get(
  "/CPLrecords/:track/:difficulty/:order/:sort/:nickname",
  async (req, res) => {
    const results = await knex("CPLTotalTrackRecords")
      .select("record", "nickname")
      .where("name", req.params.track)
      .where("difficulty", req.params.difficulty)
      .orderBy(req.params.order, req.params.sort);
    const rank =
      results
        .map((d: any) => {
          return d["nickname"];
        })
        .indexOf(req.params.nickname) + 1;
    res
      .status(200)
      .json({ result: "success", results: results.slice(0, 100), rank: rank });
  }
);

app.get("/CPLpatternList/:name/:difficulty", async (req, res) => {
  const results = await knex("CPLpatternInfo")
    .select(
      "id",
      "patternName",
      "name",
      "author",
      "description",
      "analyzed",
      "community",
      "star",
      "difficulty"
    )
    .where("name", req.params.name)
    .where("difficulty", req.params.difficulty);
  res.status(200).json({ result: "success", data: results });
});

app.get("/CPLtrackInfo/:name", async (req, res) => {
  const results = await knex("CPLpatternInfo")
    .select("name", "difficulty")
    .where("name", req.params.name);
  res.status(200).json({ result: "success", info: results });
});

app.listen(config.project.port, () => {
  signale.success(`API Server running at port ${config.project.port}.`);
});
