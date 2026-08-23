import Knex from "knex";

import config from "./config";

export const knex = Knex({
  client: "mysql2",
  connection: {
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: config.database.db,
  },
  pool: {
    min: 0,
    max: 20,
    acquireTimeoutMillis: 10000,
  },
});

export default knex;
