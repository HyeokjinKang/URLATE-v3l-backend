import Knex from "knex";

import config from "./config";

// 커넥션 풀은 이 모듈에서만 만듭니다. 모듈마다 만들면 풀이 중복 생성됩니다.
export const knex = Knex({
  client: "mysql2",
  connection: {
    host: config.database.host,
    // 설정에 있는데도 넘기지 않아 무시되고 있었습니다(항상 기본 포트 3306).
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: config.database.db,
  },
  pool: {
    min: 0,
    max: 20,
    // 기본값은 60초입니다. 풀이 마르면 요청이 그만큼 붙들려 있다가 실패하므로,
    // 앞단 타임아웃보다 짧게 잡아 빨리 되돌려 줍니다.
    acquireTimeoutMillis: 10000,
  },
});

export default knex;
