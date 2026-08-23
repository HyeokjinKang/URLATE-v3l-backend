module.exports = {
  apps: [
    {
      name: "URLATE-v3l-backend",
      script: "./dist/index.js",

      watch: false,

      // Must exceed the graceful shutdown cap (10s).
      kill_timeout: 15000,
    },
  ],
};
