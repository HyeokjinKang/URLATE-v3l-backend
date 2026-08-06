import Knex from "knex";

import config from "./config";

// 커넥션 풀은 이 모듈에서만 만듭니다. 모듈마다 만들면 풀이 중복 생성됩니다.
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
