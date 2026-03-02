module.exports = {
  apps: [
    {
      name: "URLATE-v3l-backend",
      script: "./dist/index.js",
      watch: true,
      ignore_watch: ["logs"],
    },
  ],
};
