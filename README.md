# Stakeout

Stakeout monitors HTTP/HTTPS services and shows status, history, response times, and screenshots on shared dashboards. Viewing is public; editing requires a signed-in account.

![Dashboard](doc/dashboard.png)

![Administration](doc/administration.png)

## Layout

npm workspaces under one lockfile. Use Node 26, npm 12, Docker, and Docker Compose.

| Workspace | Role |
| --- | --- |
| `core` | Shared API types |
| `server` | Express API, Prisma/PostgreSQL, check worker |
| `ui` | Angular app (nginx in production) |

## Development

```sh
npm ci
cp server/.env.example server/.env
cp ui/.env.example ui/.env
npm run docker:up
npm run db:migrate
npm run build:core
```

In separate terminals:

```sh
npm run start:server
npm run start:worker
npm run start:ui
```

Open [localhost:4200](http://localhost:4200). API on 3000. Dev login: `stakeout` / `stakeout-development-password`. Compose also starts PostgreSQL (5432) and Browserless (3030).

Or run everything in Docker:

```sh
npm run docker:up:full
```

## Commands

| Command | Purpose |
| --- | --- |
| `npm run build` | Build core, server, UI |
| `npm test` | Server + UI tests |
| `npm run db:migrate` | Apply migrations |
| `npm run db:migrate:dev` | Create a new migration |
| `npm run db:catalogs` | Refresh migration catalogs (commit with the SQL) |
| `npm run db:seed` | Example dashboards/services |
| `npm run docker:up` / `down` | Dev Postgres + Browserless |
| `npm run docker:up:full` / `down:full` | Full local stack |

After adding a migration, run `db:migrate:dev` then `db:catalogs`, and commit both. Don't edit deployed migrations.

## Configuration

| Variable | Meaning |
| --- | --- |
| `STAKEOUT_SERVER_DATABASE_URL` | PostgreSQL URL (required) |
| `STAKEOUT_SERVER_BOOTSTRAP_USERNAME` / `PASSWORD` | Create admin if missing (password ≥ 12 chars) |
| `PORT` | API port (default 3000) |
| `STAKEOUT_SERVER_CHROME_URL` | Browserless base URL |
| `STAKEOUT_SERVER_CHROME_TOKEN` | Optional Browserless token |
| `STAKEOUT_SERVER_WORKER_CONCURRENCY` | Parallel availability checks (default 3) |
| `STAKEOUT_SERVER_SCREENSHOT_WORKER_CONCURRENCY` | Parallel screenshot jobs (default 1) |
| `STAKEOUT_SERVER_CORS_ORIGIN` | Allowed UI origins (default `http://localhost:4200`) |
| `STAKEOUT_SERVER_TRUST_PROXY` | Proxy hop count or IP/CIDR list (default false) |
| `STAKEOUT_UI_SERVER_URL` | Browser-facing API URL |
| `STAKEOUT_UI_TITLE` | Dashboard title |

Behind a reverse proxy, set `STAKEOUT_SERVER_TRUST_PROXY` to the trusted hop count (e.g. `1`). Production cookies need HTTPS.

## Usage

Sign in, then enable **Edit dashboards**. All active users have full admin access. Manage accounts under **System Administration → Users**. Profile settings (theme, layout, refresh, etc.) follow signed-in users across browsers.

Availability checks run while the worker is up. Per-dashboard monitoring settings control intervals, pauses, and retention. Screenshots are captured only when someone is viewing Overview with previews and auto-refresh on.

History views: **Overview**, **Timeline**, **Services**, and **Events**. Filters and selections live in the URL. Uptime is time-weighted Up / (Up + Degraded + Down); unknown and paused time are excluded. Coverage shows how much of the range has known data.

## Images

```sh
docker build -f ui/Dockerfile -t p3000/stakeout-ui:latest .
docker build -f server/Dockerfile -t p3000/stakeout-server:latest .
```

API and worker share the server image. Default command bootstraps the DB and starts the API; run the worker with `node dist/worker.js`.

Drone builds and tests against PostgreSQL 18, then publishes amd64/arm64 images. Master updates `latest`.

## License

Copyright © 2011–2026 Preston Lee. Apache 2.0.
