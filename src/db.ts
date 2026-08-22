import Knex from "knex";

import config from "./config";

// The connection pool is created only in this module; creating one per module
// would duplicate the pool.
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
    // Default is 60s. A drained pool would hold requests that long before
    // failing, so this is kept shorter than the upstream timeout to fail fast.
    acquireTimeoutMillis: 10000,
  },
});

export default knex;
