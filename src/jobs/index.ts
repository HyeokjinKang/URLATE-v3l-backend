import schedule from "node-schedule";
import signale from "signale";

import { observer } from "../achievements";
import { knex } from "../db";
import { acquireDailyJobLock } from "../job-lock";
import { rebuild as rebuildRatingIndex } from "../rating-index";
import { cleanupReplayLogs } from "../replay-log";
import { parseJson } from "../validate";

const updateRankHistory = async () => {
  // 스케줄 콜백의 예외는 잡아 줄 호출자가 없어 unhandledRejection이 됩니다.
  try {
    // 인스턴스 간 중복 기록을 막습니다.
    if (!(await acquireDailyJobLock("rank-history"))) return;
    signale.info(new Date());
    signale.pending(`Updating rank history...`);
    const users = await knex("users")
      .select("userid", "rankHistory", "rating")
      .orderBy("rating", "desc");
    // 증분 갱신에서 생길 수 있는 누락을 하루 한 번 바로잡습니다.
    await rebuildRatingIndex(users);
    for (let i = 0; i < users.length; i++) {
      // 한 사용자의 손상된 값 때문에 작업 전체가 멈추지 않게 합니다.
      const previous = parseJson(users[i].rankHistory);
      const history = [...(Array.isArray(previous) ? previous : []), i + 1];
      await knex("users")
        .update({ rankHistory: JSON.stringify(history.slice(-19)) })
        .where("userid", users[i].userid);
      let rank100 = false,
        rank50 = false,
        rank10 = false,
        rank1 = false;
      if (i < 100) {
        rank100 = true;
        if (i < 50) {
          rank50 = true;
          if (i < 10) {
            rank10 = true;
            if (i < 1) {
              rank1 = true;
            }
          }
        }
      }
      // 순차 처리로 유저 수만큼의 쿼리가 풀(max 7)에 몰리는 것을 막습니다.
      await observer(`${users[i].userid}`, "RANK", {
        rank100,
        rank50,
        rank10,
        rank1,
      });
    }
    signale.info(new Date());
    signale.success(`Rank history updated.`);
  } catch (err) {
    signale.error(`Failed to update rank history.`);
    signale.error(err);
  }
};

// 보관 기간이 지난 리플레이 로그를 매일 정리합니다.
const cleanupLogs = async () => {
  try {
    if (!(await acquireDailyJobLock("replay-log-cleanup"))) return;
    await cleanupReplayLogs();
  } catch (err) {
    signale.error(err);
  }
};

// import 부수효과로 예약되지 않도록 기동 시 명시적으로 호출합니다.
export const scheduleJobs = () => {
  schedule.scheduleJob("59 23 * * *", updateRankHistory);
  schedule.scheduleJob("30 4 * * *", cleanupLogs);
};
