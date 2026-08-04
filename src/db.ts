import Knex from "knex";

import config from "./config";

// 커넥션 풀을 한 곳에서만 만들어 모듈 간 중복 생성을 없앱니다.
// (이전에는 index.ts와 achievements.ts가 각각 풀을 만들어 DB 커넥션을 두 배로 썼습니다.)
export const knex = Knex({
  client: "mysql2",
  connection: {
    host: config.database.host,
    user: config.database.user,
    password: config.database.password,
    database: config.database.db,
  },
  pool: { min: 0, max: 7 },
});

export default knex;
