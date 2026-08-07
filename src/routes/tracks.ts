import express from "express";

import { createErrorResponse } from "../api-response";
import { getOrSet, keys } from "../cache";
import { knex } from "../db";
import { getAllTracks } from "../services/tracks";
import { isValidFileName } from "../validate";

export const router = express.Router();

router.get("/tracks", async (req, res) => {
  // 페이지 진입마다 호출되지만 곡이 추가될 때만 바뀝니다.
  const results = await getAllTracks();
  if (!results.length) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Failed to Load",
          "Failed to load tracks. It may be a problem with the DB.",
        ),
      );
    return;
  }

  res.status(200).json({ result: "success", tracks: results });
});

router.get("/track/:name", async (req, res) => {
  const name = req.params.name;
  const results = await getOrSet(
    "tracks",
    keys.track(name),
    () =>
      knex("tracks")
        .select(
          "name",
          "fileName",
          "producer",
          "bpm",
          "difficulty",
          "originalName",
        )
        .where("name", name),
    { cacheEmpty: false },
  );
  if (!results.length) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Failed to Load",
          "Failed to load track. It may be a problem with the DB.",
        ),
      );
    return;
  }

  res.status(200).json({ result: "success", track: results });
});

router.get("/trackInfo/:filename", async (req, res) => {
  // 곡을 고를 때마다 호출되지만 패턴이 갱신될 때만 바뀝니다.
  const filename = req.params.filename;
  if (!isValidFileName(filename)) {
    res
      .status(400)
      .json(
        createErrorResponse("failed", "Wrong Format", "Invalid track name."),
      );
    return;
  }
  const results = await getOrSet(
    "trackInfo",
    keys.trackInfo(filename),
    () =>
      knex("patternInfo")
        .select("bpm", "bullet_density", "note_density", "speed")
        .where("filename", filename),
    { cacheEmpty: false },
  );
  if (!results.length) {
    res
      .status(400)
      .json(
        createErrorResponse(
          "failed",
          "Failed to Load",
          "Failed to load track data. It may be a problem with the DB.",
        ),
      );
    return;
  }
  res.status(200).json({ result: "success", info: results });
});
