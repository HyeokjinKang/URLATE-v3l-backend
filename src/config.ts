import { URLATEConfig } from "./types/config.schema";

// Read the config file in exactly one place to avoid duplicate loads across modules.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const config: URLATEConfig = require(__dirname + "/../config/config.json");

export default config;
