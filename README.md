## URLATE-v3l-backend

REST API server for [URLATE](https://github.com/HyeokjinKang/URLATE). It handles Google sign-in, sessions, user profiles and settings, track and record data, rankings, and the MIRAI announcement feeds.

### Requirements

- Node.js 24 and pnpm 12
- MySQL
- Redis, shared with the [game server](https://github.com/HyeokjinKang/URLATE-v3l-game) for sessions

### Setup

```sh
pnpm install
cp config/config_example.json config/config.json
pnpm build
pnpm dev
```

`schema/config.schema.json` documents every key in `config/config.json`. After changing the schema, run `pnpm generate-types-from-schema`.

There is no migration tool. Apply `schema/indexes.sql` and `schema/pattern-stats.sql` to the database by hand.

### Scripts

| Command                    | What it does                                   |
| -------------------------- | ---------------------------------------------- |
| `pnpm build`               | Compiles `src/` to `dist/`                     |
| `pnpm dev`                 | Runs `dist/index.js` and restarts it on change |
| `pnpm start` / `pnpm stop` | Starts or stops the server with pm2            |
| `pnpm lint`                | Runs eslint                                    |
| `pnpm format:check`        | Checks formatting with prettier                |

One-off maintenance scripts live in `src/scripts/` and run from `dist/scripts/` after a build.

### Deployment

The `Deploy` workflow is started by hand. It builds the project, copies it to the server with rsync, and reloads it with pm2.

### Security

See [SECURITY.md](SECURITY.md) for the proxy, session, CSRF and rate limit setup the server expects.
