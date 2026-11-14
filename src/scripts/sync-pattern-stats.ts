import signale from "signale";

import { knex } from "../db";
import {
  fetchPatternStats,
  PatternStats,
  readStoredStats,
  storeStats,
} from "../pattern-stats";
import { parseJson } from "../validate";

const apply = process.argv.includes("--apply");
const only = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));

const same = (a: PatternStats, b: PatternStats) =>
  a.notes === b.notes &&
  a.judges === b.judges &&
  a.requiredJudges === b.requiredJudges &&
  a.bullets === b.bullets &&
  a.holdTicks === b.holdTicks &&
  Math.abs(a.holdTickWeight - b.holdTickWeight) < 1e-9;

const main = async () => {
  signale.info(apply ? "Applying changes." : "Dry run. Pass --apply to write.");
  let tracks = await knex("tracks").select("fileName", "difficulty");
  if (only.length) {
    tracks = tracks.filter((track) => only.includes(track.fileName));
  }
  let added = 0;
  let changed = 0;
  let failed = 0;
  for (const { fileName, difficulty } of tracks) {
    const difficulties = parseJson(difficulty);
    const count = Array.isArray(difficulties) ? difficulties.length : 0;
    for (let index = 0; index < count; index++) {
      const label = `${fileName}/${index}`;
      let stats: PatternStats | null;
      try {
        stats = await fetchPatternStats(fileName, index);
      } catch (err) {
        stats = null;
        signale.error(label, err);
      }
      if (!stats) {
        failed++;
        signale.warn(`${label}: could not compute stats.`);
        continue;
      }
      const stored = await readStoredStats(fileName, index);
      if (stored && same(stored, stats)) continue;
      if (stored) changed++;
      else added++;
      signale.info(label, { stored, next: stats });
      if (apply) await storeStats(fileName, index, stats);
    }
  }
  signale.info({ tracks: tracks.length, added, changed, failed });
};

main()
  .catch((err) => {
    signale.error(err);
    process.exitCode = 1;
  })
  .finally(() => knex.destroy());
