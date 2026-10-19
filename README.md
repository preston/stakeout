# Stakeout

Stakeout monitors HTTP and HTTPS services and displays their status and screenshots on shared dashboards. Viewing is public; administration uses HTTP Basic authentication. The Angular UI supports light and dark themes.

![Dashboard](doc/dashboard.png)

![Administration](doc/administration.png)

## Platform

This is a private npm workspace monorepository:

| Workspace | Purpose |
| --- | --- |
| `core` | Browser-safe API types shared by UI and server |
| `server` | Express API, Prisma/PostgreSQL persistence, and service-check worker |
| `ui` | Angular application served by nginx in production |

Use Node 26, npm 12, Docker, and Docker Compose with `include` support. Install dependencies from the repository root. One root lockfile covers all workspaces.

## Development

```sh
npm ci
cp server/.env.example server/.env
cp ui/.env.example ui/.env
npm run docker:up
npm run db:migrate
npm run build:core
```

Start each application in a separate terminal:

```sh
npm run start:server
npm run start:worker
npm run start:ui
```

Open [localhost:4200](http://localhost:4200). The API listens on port 3000. Development credentials are `stakeout` / `password`. PostgreSQL is available at localhost:5432 and Browserless at localhost:3030. These Compose credentials are for local development.

The development Compose file starts PostgreSQL 18 and Browserless; application processes run on the host. Package-local `.env` files are optional and process environment variables take precedence. Restart the UI after changing browser configuration. Shared types compile before application startup; rebuild `core` after editing its source.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run build` | Build core, server, and UI in dependency order |
| `npm test` | Server integration tests and Angular unit tests |
| `npm run test:server` / `npm run test:ui` | Test a subsystem |
| `npm run db:generate` | Generate the Prisma client |
| `npm run db:migrate` | Validate/adopt the database and apply committed migrations |
| `npm run db:migrate:dev` | Create a development migration using Prisma |
| `npm run db:catalogs` | Replay migrations in disposable PostgreSQL 18 and refresh schema manifests |
| `npm run db:seed` | Explicitly create example dashboards and services |
| `npm run check:1-minute` / `npm run check:5-minutes` | Enqueue service checks older than that interval |
| `npm run verify:chrome` / `npm run verify:queue` | Verify screenshot capture or inspect queue state |
| `npm run docker:up` / `npm run docker:down` | Start/stop development infrastructure |
| `npm run docker:up:full` / `npm run docker:down:full` | Build/start or stop the full local platform |

PostgreSQL-backed tests use disposable `postgres:18` Docker containers and isolated databases. They fail if PostgreSQL 18 cannot be started. In CI, `STAKEOUT_TEST_DATABASE_URL` identifies the dedicated PostgreSQL 18 test service; the test user must be allowed to create and drop databases. Never point it at a production database.

When adding a database migration, run `npm run db:migrate:dev`, then `npm run db:catalogs`, and commit the migration SQL and its catalog manifest together. Bootstrap validates every applied migration prefix against these manifests. Never edit an already deployed migration.

## Full local stack

```sh
npm run docker:up:full
```

The root `docker-compose.full.yml` includes development infrastructure and adds the API, worker, and UI. The API validates and migrates its database before becoming healthy; the worker starts after API readiness. Data persists in the named PostgreSQL volume. Ordinary `docker:down` commands retain the volume.

Compose uses container service names for server connections and browser-accessible localhost addresses for UI configuration. Override these addresses and credentials for a hosted environment.

## Configuration

| Variable | Meaning |
| --- | --- |
| `STAKEOUT_SERVER_DATABASE_URL` | PostgreSQL connection URL; required by API and worker |
| `STAKEOUT_SERVER_USERNAME` / `STAKEOUT_SERVER_PASSWORD` | Administration credentials |
| `PORT` | API port; default 3000 |
| `STAKEOUT_SERVER_CHROME_URL` | Browserless base URL; HTTP(S), WS(S), and bare host forms are accepted |
| `STAKEOUT_SERVER_CHROME_TOKEN` | Optional Browserless token |
| `STAKEOUT_SERVER_WORKER_CONCURRENCY` | Simultaneous service checks; default 3 |
| `STAKEOUT_SERVER_WORKER_LEASE_MS` | Worker lease duration; default 90000, greater than the check deadline |
| `STAKEOUT_SERVER_WORKER_POLL_INTERVAL_MS` | Idle worker poll interval; default 1000 |
| `STAKEOUT_SERVER_CORS_ORIGIN` | Allowed browser origin; default `*` |
| `STAKEOUT_SERVER_TRUST_PROXY` | Honor forwarded host/protocol headers; default true, set false for direct exposure |
| `STAKEOUT_UI_SERVER_URL` | Browser-accessible API base URL; default http://localhost:3000 |
| `STAKEOUT_UI_TITLE` | Dashboard title; default My Stakeout |

Forwarded-header handling defaults to true for proxy compatibility. Set it to false for direct exposure; behind a proxy, configure the proxy to overwrite client-supplied forwarded headers. Browser configuration is generated at UI startup, so the same image can serve different deployments. Keep secrets in environment files or your hosting platform's secret store.

## API and monitoring

Requests use `Accept: application/json` or a `.json` suffix. Public endpoints include `/`, `/dashboards`, `/dashboards/:id`, nested `/dashboards/:dashboard_id/services` and `/status`. Dashboard and nested service writes require Basic authentication; `POST /test` verifies administration credentials. Create/update bodies contain a `dashboard` or `service` object.

Lists accept `sort` and `order`; text search uses PostgreSQL prefix full-text search. Set `screenshots=true` on a service list to include Base64 PNG previews. Dates and attribute names retain the public JSON contract.

Reading a dashboard's service list enqueues checks for services not checked in the last minute. The worker consumes durable PostgreSQL jobs; it does not continuously schedule monitoring. Manual sweep commands can be run by an external scheduler. Checks treat HTTP status codes 200–399 as healthy, honor configured ports, and capture screenshots through Browserless when previews are enabled. Updating a service invalidates its last check and screenshot.

## Images and CI

Build from the repository root:

```sh
docker build -f ui/Dockerfile -t p3000/stakeout-ui:latest .
docker build -f server/Dockerfile -t p3000/stakeout-server:latest .
```

The API and worker share the server image. Its default command runs database bootstrap and starts the API. Start the worker with `node dist/worker.js`; `bin/jobs` is also available. The worker waits for database readiness and never applies migrations.

The root Drone pipeline validates builds and tests using PostgreSQL 18, then publishes UI and server images for amd64 and arm64. Successful master builds update the multiarchitecture `latest` manifests. Registry credentials use the existing `docker_username` and `docker_password` Drone secrets.

## Existing deployments and database upgrades

The API image supports adopting the existing database schema revision `20260204210100`. It verifies actual schema definitions before recording the baseline. Unknown revisions, schema drift, failed migrations, and migration histories newer than the image prevent startup. An empty database is initialized through the same committed migration history, producing the same final application schema.

Database bootstrap holds a session advisory lock for the entire adoption and migration sequence. Use a direct or session-preserving PostgreSQL connection for `STAKEOUT_SERVER_DATABASE_URL`.

For cutover:

1. Back up the database and verify that the backup can be restored.
2. Stop the existing API and workers during a maintenance window.
3. Deploy the replacement API using the existing database URL and storage. Wait for successful database bootstrap and `/status` readiness.
4. Start the worker and UI, verify administration and screenshots, and run `npm run check:1-minute` or the corresponding server workspace command to enqueue stale checks.

Retired job and metadata tables are removed during migration. Existing dashboard/service data and stored screenshots are retained, and stale checks are enqueued once during the database transition. After migration, returning to an earlier image requires restoring the backup. A failed migration requires operator investigation and Prisma recovery or restoration; startup never silently repairs migration history.

## Attribution and license

Copyright © 2011–2026 Preston Lee. All rights reserved. Provided under the Apache 2.0 license.
