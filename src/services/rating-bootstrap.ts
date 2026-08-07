import signale from "signale";

import { knex } from "../db";
import {
  acquireRebuildLock,
  rebuild as rebuildRatingIndex,
  releaseRebuildLock,
} from "../rating-index";

// 최초 기동·Redis 재시작 이후 rating 인덱스를 복구합니다.
// 성공해도 락을 만료까지 두어, 인덱스가 빈 동안 users 전체 조회가 연달아
// 발생하지 않게 합니다.
export const rebuildRatingIndexIfNeeded = async () => {
  if (!(await acquireRebuildLock())) return;
  try {
    const users = await knex("users").select("userid", "rating");
    await rebuildRatingIndex(users);
  } catch (err) {
    signale.error(err);
    // 실패하면 곧바로 재시도할 수 있도록 락을 풉니다.
    await releaseRebuildLock();
  }
};
