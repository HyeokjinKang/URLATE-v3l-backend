/* eslint-disable @typescript-eslint/no-var-requires */
import * as bodyParser from "body-parser";
import * as session from "express-session";
import cookieParser from "cookie-parser";
import express from "express";
import mysqlSession from "express-mysql-session";
import signale from "signale";
import knexClient from "knex";
import jwt_decode from "jwt-decode";
import { URLATEConfig } from "./types/config.schema";
import {
  createSuccessResponse,
  createErrorResponse,
  createStatusResponse,
} from "./api-response";

const config: URLATEConfig = require(__dirname + "/../config/config.json");
const settingsConfig = require(__dirname + "/../config/settings.json");

const MySQLStore = mysqlSession(session);

const app = express();
app.locals.pretty = true;

const knex = knexClient({
  client: "mysql",
  connection: {
    host: config.database.host,
    user: config.database.user,
    password: config.database.password,
    database: config.database.db,
  },
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

app.post("/auth/login", (req, res) => {
  const payload: any = jwt_decode(req.body.jwt.credential);
  if (payload.email == "bjgumsun@gmail.com") {
    req.session.userid = payload.sub;
    req.session.email = payload.email;
    req.session.tempName = payload.name;
    req.session.save(() => {
      signale.debug(new Date());
      signale.debug(`User logined : ${payload.email}`);
      res.status(200).json(createSuccessResponse("success"));
    });
  } else {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Not whitelisted",
          "App is testing now. Only testers can login."
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
    .select("nickname", "settings", "skins", "userid", "tutorial")
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
  } catch (e) {
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
  } catch (e) {
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
      isBest: isBest,
    });
  } catch (e) {
    res
      .status(400)
      .json(createErrorResponse("failed", "Error occured while updating", e));
    return;
  }
  res.status(200).json(createSuccessResponse("success"));
});

app.get("/record/:track/:name", async (req, res) => {
  const results = await knex("trackRecords")
    .select("rank", "record", "maxcombo", "medal", "difficulty")
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
        .map((d) => {
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
  } catch (e) {
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
  delete req.session.vaildChecked;
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

app.listen(config.project.port, () => {
  signale.success(`API Server running at port ${config.project.port}.`);
});
