# Stakeout

Stakeout continuously monitors HTTP and HTTPS services and displays their current status, availability history, response-time summaries, and current screenshots on shared dashboards. Viewing is public; administration uses database-backed username/password accounts and cookie sessions. The Angular UI supports light and dark themes.

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

Open [localhost:4200](http://localhost:4200). The API listens on port 3000. Development credentials are `stakeout` / `stakeout-development-password`. PostgreSQL is available at localhost:5432 and Browserless at localhost:3030. These Compose credentials are for local development.

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
| `STAKEOUT_SERVER_BOOTSTRAP_USERNAME` / `STAKEOUT_SERVER_BOOTSTRAP_PASSWORD` | Create this account if missing; password must be at least 12 characters |
| `PORT` | API port; default 3000 |
| `STAKEOUT_SERVER_CHROME_URL` | Browserless base URL; HTTP(S), WS(S), and bare host forms are accepted |
| `STAKEOUT_SERVER_CHROME_TOKEN` | Optional Browserless token |
| `STAKEOUT_SERVER_WORKER_CONCURRENCY` | Simultaneous availability checks per worker process; default 3 |
| `STAKEOUT_SERVER_SCREENSHOT_WORKER_CONCURRENCY` | Separate screenshot consumers per worker process; default 1 |
| `STAKEOUT_SERVER_WORKER_LEASE_MS` | Worker lease duration; default 90000, greater than the check deadline |
| `STAKEOUT_SERVER_WORKER_POLL_INTERVAL_MS` | Idle worker poll interval; default 1000 |
| `STAKEOUT_SERVER_HISTORY_PRUNE_INTERVAL_MS` | Time between bounded history pruning passes; default 60000 |
| `STAKEOUT_SERVER_HISTORY_PRUNE_BATCH_SIZE` | Maximum rows per history table processed per pruning pass; default 1000 |
| `STAKEOUT_SERVER_CORS_ORIGIN` | Comma-separated explicit UI origins for credentialed requests; default `http://localhost:4200` |
| `STAKEOUT_SERVER_TRUST_PROXY` | Trusted proxy hop count or IP/CIDR list; default false (direct exposure) |
| `STAKEOUT_UI_SERVER_URL` | Browser-accessible API base URL; default http://localhost:3000 |
| `STAKEOUT_UI_TITLE` | Dashboard title; default My Stakeout |

Forwarded headers are ignored by default. Behind a proxy, set `STAKEOUT_SERVER_TRUST_PROXY` to its trusted hop count (for example `1`) or IP/CIDR list. Trust only the actual deployment proxy, and configure it to overwrite client-supplied forwarded headers. `true` remains an explicit opt-in for deployments whose proxies sanitize every forwarded header. Browser configuration is generated at UI startup, so the same image can serve different deployments. Keep secrets in environment files or your hosting platform's secret store.

## Accounts and personal preferences

Use **Sign in** in the navbar, then enable **Edit dashboards** to edit dashboards and services. Edit mode pauses automatic refresh and resets on reload or sign-out. All active authenticated users have full administrative access.

**System Administration → Users** (`/admin/users`) provides account creation, username/display-name editing, activation, password resets, and permanent deletion. The last active account cannot be disabled or deleted, including by concurrent requests. Disabling/deleting an account or resetting its password revokes its sessions. Resetting your own password through administration signs you out; changing it through `/profile` keeps your current browser signed in and revokes other sessions.

Set `STAKEOUT_SERVER_BOOTSTRAP_USERNAME` and `STAKEOUT_SERVER_BOOTSTRAP_PASSWORD` together to create an account on API startup. Existing matching accounts keep their passwords, status, and preferences. Both variables may be omitted after accounts exist; startup refuses an empty user store without bootstrap credentials. Deleting or renaming the configured account causes it to be recreated at the next startup until these variables are changed or removed. Workers never provision accounts. The old shared authentication variables are no longer read.

The `/profile` page saves account details, theme, developer/experimental flags, screenshot visibility, layout, refresh interval, and sort/order preferences. Dashboard toolbar choices save automatically for signed-in users and follow the account across browsers. Guests have temporary toolbar preferences. Browser settings and stored credentials from earlier versions are discarded without importing them; unrelated browser storage is retained.

`POST /auth/login` accepts a JSON object with `username` and `password` and returns user details, preferences, an expiry, and a CSRF token. `GET /auth/session` restores this state, and `POST /auth/logout` revokes the current session. `GET/PATCH /users/me`, `GET/PATCH /users/me/settings`, and `POST /users/me/password` handle personal data. Account administration uses `GET/POST /admin/users`, `GET/PATCH/DELETE /admin/users/:id`, and `POST /admin/users/:id/password`. Personal password changes accept `currentPassword` and `password`; administrative resets accept `password`. New account APIs use camelCase. Dashboard/service JSON keeps its existing snake_case names.

Sessions last seven days and are stored in PostgreSQL; passwords use salted scrypt hashes and only hashes of random session tokens are stored. Authenticated mutations require the session's CSRF token. Login failures are rate limited to 10 per normalized username and 60 per source address within 15 minutes; IPv6 addresses are grouped by subnet. Session restoration waits at most eight seconds so a stalled API cannot block the UI indefinitely. Configure an explicit `STAKEOUT_SERVER_CORS_ORIGIN` allowlist and send browser requests with credentials. Production cookies use `HttpOnly; Secure; SameSite=None`, requiring HTTPS in hosted deployments; local HTTP development uses `SameSite=Lax`. The full localhost Compose example uses the browser's localhost Secure-cookie exception. If third-party cookies are blocked, serve the UI and API under the same site.

## API and monitoring

Requests use `Accept: application/json`, a `.json` suffix, or `?format=json`. Public endpoints include `/`, `/dashboards`, `/dashboards/:id`, nested `/dashboards/:dashboard_id/services` and `/status`. Dashboard and nested service writes require a valid session cookie and an `X-CSRF-Token` header; Basic authentication and `POST /test` are removed. Create/update bodies contain a `dashboard` or `service` object.

Lists accept `sort` and `order`; text search uses PostgreSQL prefix full-text search. Set `screenshots=true` on a service list to include Base64 PNG previews. Dates and attribute names retain the public JSON contract.

The dashboard uses `screenshots=urls` instead: each service includes a nullable `screenshot` with `preview_url` and `original_url`, without inline image data. The URLs contain a SHA-256 hash of the original capture and are cached independently for one year as immutable resources. Status and check timestamps do not change image URLs. Polling still enqueues stale checks even when the metadata response is `304 Not Modified`.

Captures retain the 1280 × 1280 desktop viewport. The worker generates a square 600 × 600 WebP preview at quality 80 alongside each original PNG. The dashboard loads previews; clicking one opens the original in a dialog with a blurred, clickable backdrop, Close and native browser full-screen controls. The dashboard and open dialog continue updating at the selected refresh interval. Escape closes the dialog; while in native full screen, the browser may first use Escape to exit full screen. Native full screen requires browser support and permission (normally HTTPS or localhost). Existing stored captures receive content hashes during migration; their previews are generated on demand without modifying service rows until the next worker capture stores a preview. If a capture finishes between metadata and image requests, obsolete image URLs redirect to the current version without caching the redirect. Failed image downloads retry on the next dashboard response. Editing a service clears both image variants and their hash together.

Availability monitoring runs continuously while the worker is running, independently of dashboard viewers. Each dashboard starts with monitoring enabled and a 60-second check interval. Use **Monitoring settings** while editing a dashboard to pause availability checks or change its intervals and retention. A pause is recorded explicitly. Services without enabled protocols are unconfigured. Checks treat HTTP status codes 200–399 as healthy and honor configured ports. Reading a service list and the legacy sweep commands respect dashboard pauses and configured cadence; an external scheduler is no longer required.

Availability and screenshots use separate durable PostgreSQL job rows and consumer pools. Each service has at most one row per task kind, rescheduled after completion. Claims use leases and execution tokens; multiple worker processes can share the same database. Missed checks coalesce into a new observation when workers recover. Network failures are unavailable observations; database, worker, and lease failures do not assert that the target is down. Editing a monitored target preserves its prior configuration in history, invalidates its latest check/current screenshot, and fences older in-flight results.

Screenshots are captured only while a visible Overview has previews displayed and automatic screen refresh enabled. The UI renews a dashboard-level demand lease every 30 seconds; it expires after 90 seconds without viewers. Multiple viewers share the same capture schedule. Dashboard screenshot settings and the existing per-service preview flag both apply. Availability pauses do not disable viewer-demanded screenshots. Only the latest original/preview pair is stored; history never stores screenshots.

## History views and interpretation

**Overview** remains the default. It adds status totals, measured uptime and coverage, and a small availability strip on each service. **Timeline** aligns service history on a common time axis. **Services** provides sortable uptime, downtime, outages, latest checks, and response-time summaries. **Events** lists status changes, recoveries, pauses, gaps, and target changes. Click a service or event for protocol diagnostics, configuration, outages, and performance charts. Date/service/status filters and detail selections are shareable in the page URL. The default date range is 24 hours; 7-, 30-, and 90-day presets and custom dates are available. Display times use the browser timezone; timestamps and aggregate boundaries are stored in UTC.

Each accepted check updates a continuing availability interval. A new interval is created only when protocol availability, configuration, or monitoring state changes. Up means all enabled protocols succeed; Degraded means only some succeed; Down means all fail. Checks use the HTTP response headers without downloading the body, so streaming endpoints can be monitored. Response times measure latency to those headers. Changing a dashboard’s check interval requests a fresh check immediately while preserving the last observation; pauses still take precedence. A single observation records a change immediately, so short observed outages remain visible even in coarse timeline buckets. Detection times are limited by the check interval and request duration, rather than proving when the physical failure began.

An observation becomes Unknown after three of its check intervals without a new accepted result. The same boundary is reconstructed if the entire worker was stopped. Uptime is time-weighted **Up / (Up + Degraded + Down)**; unknown and paused time do not enter that denominator. Coverage shows how much of the selected range has known observations, so sparse history cannot silently imply continuous uptime. Dashboard statistics sum service durations across all matching services, including services outside the current page. History before monitoring began and history removed by retention are labeled separately. Outages end with recovery or an explicit interruption by an unknown period, pause, or target change.

Response-time samples update counters directly in one hourly and one daily row per service. Each stores separate HTTP/HTTPS check/failure counts and response-time count/sum/minimum/maximum. Response-time charts include received HTTP response headers, including unsuccessful status codes; network errors without a response have no response-time sample. Charts prefer hourly data when it covers a UTC day's retained observations and fall back to daily data when hours are missing or incomplete. Available hourly data is used when that day's daily summary has already been pruned. Changing retention cannot hide still-retained fallback data or count both resolutions twice. Performance summaries count full overlapping retained buckets, which can extend beyond the selected date endpoints; their displayed bucket times identify that resolution. Availability statistics use the actual interval boundaries.

History endpoints are public, consistent with dashboard viewing:

| Endpoint | Result |
| --- | --- |
| `GET /dashboards/:id/history` | Filtered service summaries, dashboard statistics, and timeline buckets |
| `GET /dashboards/:id/events` | Chronological status and monitoring events |
| `GET /dashboards/:id/services/:serviceId/history` | Service intervals, diagnostics, configuration, performance, and outages |
| `GET /dashboards/:id/history/export.csv?dataset=services` | Streamed service-summary CSV; use `dataset=events` for events |
| `POST /dashboards/:id/screenshot-demand` | Renew the bounded live-preview lease; JSON body and allowed browser origin required |

History reads accept ISO `from`/`to`, `service_id` (comma-separated IDs), `state`, `page`, and `limit` (maximum 100). Service summaries also support `sort`/`order`. Service history accepts `event_id` to retrieve one event’s exact diagnostics, including events outside the latest interval page. Removed or out-of-range events return `selected_event: null` and no diagnostic intervals. Outages have independent `outage_page` and `outage_pagination` fields; changing the observation page does not change the outage page. Timeline and chart data are bounded to 240 points per service. CSV exports apply the same range and filters and use one consistent database snapshot across pages, even while checks continue. Exports have a 120-second transaction limit; use a narrower range if an export exceeds it. Dashboard monitoring settings use the existing authenticated dashboard update endpoint and snake_case JSON attributes.

## Retention and storage sizing

Choose retention under the dashboard's **Advanced** monitoring settings. `hourly_retention_days` defaults to 14; `daily_retention_days` and `availability_retention_days` default to `null`, meaning keep indefinitely. Each policy is independent and accepts a positive number of days or `null`. Saving a shorter policy permits automatic deletion at subsequent pruning passes; increasing it cannot restore deleted data. Pruning retains open availability intervals and intervals crossing the cutoff. Deleting a service or dashboard permanently removes its history.

For **N** continuously monitored services, **H** retained hourly days, and **D** retained daily days, estimate **N × 24 × H hourly rows + N × D daily rows**, plus actual availability transitions and configuration revisions. Hourly data reaches a rolling bound; indefinitely retained daily data grows by about 365 rows per service each year. The number of checks inside a bucket does not change its row count. These are row counts, not byte-size promises; PostgreSQL indexes, diagnostic lengths, vacuum behavior, and real transition frequency affect disk use.

| Example profile | Services | Hourly policy | Daily policy | Approximate performance rows after one year |
| --- | ---: | ---: | ---: | ---: |
| Small installation | 10 | 14 days | Indefinite | 7,010 |
| Bounded installation | 100 | 7 days | 365 days | 53,300 |
| Larger installation | 1,000 | 14 days | 365 days | 701,000 |
| Longer hourly detail | 1,000 | 90 days | Indefinite | 2,525,000 |

For comparison, storing every one-minute check for 1,000 services would create about 1.44 million sample rows per day. Stakeout stores no such sample table, and its queue remains bounded to two task rows per service. Availability can still grow rapidly when a target repeatedly changes state; choose a finite availability retention policy if that matters for your resources.

Set a shorter hourly policy when recent performance detail matters most. Keep daily summaries longer for trends, and retain exact availability changes as long as operationally useful. Start with the defaults, measure database size and transition frequency, then tune each dashboard. To reduce cleanup work per pass, lower `STAKEOUT_SERVER_HISTORY_PRUNE_BATCH_SIZE` or increase `STAKEOUT_SERVER_HISTORY_PRUNE_INTERVAL_MS`; large existing backlogs may take multiple passes to clear. Monitor database vacuuming and physical disk size as well as live row counts.

Worker capacity depends on request duration and enabled protocols. A fleet of 1,000 services checked every minute needs about 16.7 completed service checks per second. Increase availability concurrency or run additional worker processes if checks become overdue. Screenshots use their own concurrency setting and can be kept low without consuming availability consumers. A slower configured interval is also appropriate for constrained resources. Readiness reports database availability; unknown services and their last-check times reveal monitoring gaps.

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
3. Configure the new bootstrap variables and explicit UI CORS origins. Deploy the replacement API using the existing database URL and storage. Wait for successful database bootstrap and `/status` readiness.
4. Start the worker and UI, verify administration, automatic checks, history, and viewer-demanded screenshots. Existing external sweep schedules can be removed.

Application tables and columns are renamed to Prisma conventions, and User/Session tables are added. API, worker, and UI versions must be deployed together during the maintenance window; older workers cannot use the renamed schema. Retired job and metadata tables are removed during migration. Existing dashboard/service data and stored screenshots are retained, and stale checks are enqueued once during the database transition. After migration, returning to an earlier image requires restoring the backup. A failed migration requires operator investigation and Prisma recovery or restoration; startup never silently repairs migration history.

The availability-history migration adds monitoring settings, configuration snapshots, intervals, and compact aggregates. It rebuilds transient queue state into reusable schedules and staggers initial availability jobs over the first minute. Historical observation begins at this migration; the most recent legacy status is not extrapolated into earlier availability. Monitoring is enabled by default on existing dashboards. Review dashboard intervals, retention, and worker capacity when upgrading. The following requested-check migration adds a nullable scheduling timestamp; it preserves existing observations and history while enabling immediate checks after interval edits.

## Attribution and license

Copyright © 2011–2026 Preston Lee. All rights reserved. Provided under the Apache 2.0 license.
