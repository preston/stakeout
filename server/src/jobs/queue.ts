import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { reconcileServiceHistory } from '../history/recording.ts';

export const STALE_CHECK_MS = 60_000;
export const DEFAULT_LEASE_MS = 90_000;
export type JobKind = 'availability' | 'screenshot';

let pool: Pool | undefined;
let configuredDatabaseUrl: string | undefined;
let historyCursor: string | null = null;

export function configureJobDatabase(databaseUrl: string): void {
  if (pool && configuredDatabaseUrl !== databaseUrl) {
    throw new Error('Close the current job database before changing its connection URL');
  }
  configuredDatabaseUrl = databaseUrl;
}

export function jobDatabase(): Pool {
  if (!pool) {
    const connectionString = configuredDatabaseUrl ?? process.env.STAKEOUT_SERVER_DATABASE_URL;
    if (!connectionString) throw new Error('STAKEOUT_SERVER_DATABASE_URL is required');
    configuredDatabaseUrl = connectionString;
    pool = new Pool({
      connectionString, options: '-c timezone=UTC', max: 12,
      connectionTimeoutMillis: 5000, statement_timeout: 60_000,
    });
    pool.on('error', (error) => console.error('Job database connection failed:', error.message));
  }
  return pool;
}

export async function closeJobDatabase(): Promise<void> {
  const current = pool;
  pool = undefined;
  configuredDatabaseUrl = undefined;
  historyCursor = null;
  if (current) await current.end();
}

export interface ServiceCheckJob {
  id: string;
  serviceId: string;
  kind: JobKind;
  status: 'pending' | 'running' | 'completed' | 'failed';
  lockedBy: string | null;
  attempts: number;
  maxAttempts: number;
}

function validateAge(maxAgeMs: number): void {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new Error('The service check age must be a nonnegative number of milliseconds');
  }
}

async function enqueueMatchingServices(
  filter: 'service' | 'dashboard' | 'all',
  id: string | null,
  maxAgeMs: number,
): Promise<number> {
  validateAge(maxAgeMs);
  // Viewer polling and manual sweeps never accelerate a dashboard's configured
  // cadence, bypass a pause, or replace a claim belonging to another worker.
  const result = await jobDatabase().query(
    `INSERT INTO "ServiceCheckJob" (id, "serviceId", kind, status, "availableAt", "createdAt", "updatedAt")
     SELECT gen_random_uuid(), s.id, 'availability', 'pending', now(), now(), now()
     FROM "Service" s JOIN "Dashboard" d ON d.id = s."dashboardId"
     WHERE ($1::text = 'all' OR ($1 = 'service' AND s.id = $2::uuid)
       OR ($1 = 'dashboard' AND s."dashboardId" = $2::uuid))
       AND d."monitoringEnabled" AND (s.http IS TRUE OR s.https IS TRUE)
       AND (s."checkedAt" IS NULL OR s."availabilityCheckRequestedAt" IS NOT NULL OR s."checkedAt" <= (now() AT TIME ZONE 'UTC')
         - GREATEST($3, d."checkIntervalSeconds" * 1000) * interval '1 millisecond')
     FOR KEY SHARE OF s SKIP LOCKED
     ON CONFLICT ("serviceId", kind) DO NOTHING`,
    [filter, id, maxAgeMs],
  );
  return result.rowCount ?? 0;
}

export async function enqueueServiceCheck(serviceId: string, options: { maxAgeMs?: number } = {}): Promise<boolean> {
  return (await enqueueMatchingServices('service', serviceId, options.maxAgeMs ?? 0)) > 0;
}

export function enqueueDashboardChecks(dashboardId: string, maxAgeMs = 0): Promise<number> {
  return enqueueMatchingServices('dashboard', dashboardId, maxAgeMs);
}

export function enqueueStaleServiceChecks(maxAgeMs = 0): Promise<number> {
  return enqueueMatchingServices('all', null, maxAgeMs);
}

export function enqueueChecksOlderThanOneMinute(): Promise<number> {
  return enqueueStaleServiceChecks(STALE_CHECK_MS);
}

export function enqueueChecksOlderThanFiveMinutes(): Promise<number> {
  return enqueueStaleServiceChecks(5 * STALE_CHECK_MS);
}

/** Fill missing durable rows. Due timestamps coalesce missed checks into one run. */
export async function scheduleDueServiceJobs(): Promise<number> {
  const result = await jobDatabase().query(
    `INSERT INTO "ServiceCheckJob" ("serviceId", kind, "availableAt")
     SELECT s.id, task.kind, GREATEST(now(), CASE WHEN task.kind = 'availability'
       THEN COALESCE(s."checkedAt" AT TIME ZONE 'UTC' + d."checkIntervalSeconds" * interval '1 second', now())
       ELSE COALESCE(s."screenshotCheckedAt" + d."screenshotIntervalSeconds" * interval '1 second', now()) END)
     FROM "Service" s JOIN "Dashboard" d ON d.id = s."dashboardId"
     CROSS JOIN (VALUES ('availability'), ('screenshot')) AS task(kind)
     WHERE (s.http IS TRUE OR s.https IS TRUE)
       AND ((task.kind = 'availability' AND d."monitoringEnabled")
         OR (task.kind = 'screenshot' AND d."screenshotsEnabled" AND s."httpPreview" IS TRUE
           AND d."screenshotDemandUntil" > now()))
     FOR KEY SHARE OF s SKIP LOCKED
     ON CONFLICT ("serviceId", kind) DO NOTHING`,
  );
  return result.rowCount ?? 0;
}

export async function recoverExpiredJobs(): Promise<number> {
  const result = await jobDatabase().query(
    `UPDATE "ServiceCheckJob"
     SET status = 'pending',
       "availableAt" = now() + CASE WHEN attempts >= "maxAttempts" THEN 60 ELSE 0 END * interval '1 second',
       attempts = CASE WHEN attempts >= "maxAttempts" THEN 0 ELSE attempts END,
       "lockedBy" = NULL, "leaseExpiresAt" = NULL,
       "lastError" = 'Worker lease expired', "updatedAt" = now(), "completedAt" = NULL
     WHERE status = 'running' AND "leaseExpiresAt" <= now()`,
  );
  return result.rowCount ?? 0;
}

/** Legacy terminal rows are recycled: continuous monitoring must recover itself. */
export async function pruneFinishedJobs(): Promise<number> {
  const result = await jobDatabase().query(
    `UPDATE "ServiceCheckJob" SET status = 'pending', attempts = 0,
       "availableAt" = now(), "completedAt" = NULL, "lockedBy" = NULL, "leaseExpiresAt" = NULL,
       "updatedAt" = now()
     WHERE id IN (SELECT id FROM "ServiceCheckJob" WHERE status IN ('completed', 'failed')
       ORDER BY "updatedAt" LIMIT 1000 FOR UPDATE SKIP LOCKED)`,
  );
  return result.rowCount ?? 0;
}

/** A bounded, serialized pass materializes pauses/gaps even without observations. */
export async function reconcileHistories(batchSize = 1000): Promise<number> {
  const client = await jobDatabase().connect();
  try {
    await client.query('BEGIN');
    const maintenance = await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_xact_lock(1398030667) AS acquired');
    if (!maintenance.rows[0]?.acquired) { await client.query('ROLLBACK'); return 0; }
    // Select only transitions requiring maintenance. Healthy observations already
    // extend their interval in the completion transaction, so they need no scan writes.
    const candidates = await client.query<{ id: string; dashboardId: string }>(
      `SELECT s.id, s."dashboardId" FROM "Service" s JOIN "Dashboard" d ON d.id=s."dashboardId"
       LEFT JOIN "AvailabilityInterval" i ON i."serviceId"=s.id AND i."endedAt" IS NULL
       LEFT JOIN "ServiceConfiguration" c ON c.id=i."configurationId"
       WHERE ($1::uuid IS NULL OR s.id > $1::uuid) AND (
         i.id IS NULL OR c.revision IS DISTINCT FROM s."configRevision"
         OR (NOT d."monitoringEnabled" AND i.state <> 'paused')
         OR (d."monitoringEnabled" AND i.state = 'paused')
         OR (d."monitoringEnabled" AND NOT (coalesce(s.http,false) OR coalesce(s.https,false))
           AND i.reason IS DISTINCT FROM 'unconfigured')
         OR (i.state IN ('up','degraded','down') AND i."lastObservedAt" IS NOT NULL
           AND i."lastObservedAt" + i."checkIntervalSeconds" * interval '3 seconds' <= now()))
       ORDER BY s.id LIMIT $2`,
      [historyCursor, Math.max(1, Math.min(1000, Math.floor(batchSize)))],
    );
    // Settings writers acquire Dashboard before Service; keep the same order.
    const dashboards = await client.query<{ id: string }>(
      'SELECT id FROM "Dashboard" WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE SKIP LOCKED',
      [Array.from(new Set(candidates.rows.map((row) => row.dashboardId)))],
    );
    const services = await client.query<{ id: string }>(
      `SELECT id FROM "Service" WHERE "dashboardId"=ANY($1::uuid[]) AND id=ANY($2::uuid[])
       ORDER BY id FOR UPDATE SKIP LOCKED`,
      [dashboards.rows.map((row) => row.id), candidates.rows.map((row) => row.id)],
    );
    const at = new Date();
    for (const service of services.rows) await reconcileServiceHistory(client, service.id, at);
    await client.query('COMMIT');
    historyCursor = candidates.rows.at(-1)?.id ?? null;
    return services.rows.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function claimNextJob(
  workerId: string,
  leaseMs = DEFAULT_LEASE_MS,
  kind: JobKind = 'availability',
): Promise<ServiceCheckJob | null> {
  const claimToken = `${workerId}:${randomUUID()}`;
  const result = await jobDatabase().query<ServiceCheckJob>(
    `UPDATE "ServiceCheckJob" j
     SET status = 'running', "lockedBy" = $1, "leaseExpiresAt" = now() + $2 * interval '1 millisecond',
       attempts = attempts + 1, "updatedAt" = now()
     WHERE j.id = (
       SELECT q.id FROM "ServiceCheckJob" q
       JOIN "Service" s ON s.id = q."serviceId" JOIN "Dashboard" d ON d.id = s."dashboardId"
       WHERE q.status = 'pending' AND q.kind = $3 AND q."availableAt" <= now()
         AND (s.http IS TRUE OR s.https IS TRUE)
         AND (($3 = 'availability' AND d."monitoringEnabled"
             AND (s."checkedAt" IS NULL OR s."availabilityCheckRequestedAt" IS NOT NULL OR s."checkedAt" <= (now() AT TIME ZONE 'UTC')
               - d."checkIntervalSeconds" * interval '1 second'))
           OR ($3 = 'screenshot' AND d."screenshotsEnabled" AND s."httpPreview" IS TRUE
             AND d."screenshotDemandUntil" > now()
             AND (s."screenshotCheckedAt" IS NULL OR s."screenshotCheckedAt" <= (now() AT TIME ZONE 'UTC')
               - d."screenshotIntervalSeconds" * interval '1 second')))
       ORDER BY q."availableAt", q."createdAt", q.id
       FOR UPDATE OF q SKIP LOCKED LIMIT 1
     ) RETURNING j.*`,
    [claimToken, leaseMs, kind],
  );
  return result.rows[0] ?? null;
}

export async function heartbeatJob(job: ServiceCheckJob, leaseMs = DEFAULT_LEASE_MS): Promise<boolean> {
  const result = await jobDatabase().query(
    `UPDATE "ServiceCheckJob" SET "leaseExpiresAt" = now() + $3 * interval '1 millisecond', "updatedAt" = now()
     WHERE id = $1 AND "lockedBy" = $2 AND status = 'running' AND "leaseExpiresAt" > now()`,
    [job.id, job.lockedBy, leaseMs],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function failJob(job: ServiceCheckJob, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await jobDatabase().query(
    `UPDATE "ServiceCheckJob"
     SET status = 'pending',
       "availableAt" = now() + LEAST(60000, 1000 * power(2, GREATEST(attempts - 1, 0))) * interval '1 millisecond',
       attempts = CASE WHEN attempts >= "maxAttempts" THEN 0 ELSE attempts END,
       "lockedBy" = NULL, "leaseExpiresAt" = NULL, "lastError" = $3, "updatedAt" = now(), "completedAt" = NULL
     WHERE id = $1 AND "lockedBy" = $2 AND status = 'running' AND "leaseExpiresAt" > now()`,
    [job.id, job.lockedBy, message.slice(0, 2000)],
  );
}

export async function releaseJob(job: ServiceCheckJob): Promise<void> {
  await jobDatabase().query(
    `UPDATE "ServiceCheckJob" SET status = 'pending', "availableAt" = now(),
       "lockedBy" = NULL, "leaseExpiresAt" = NULL, attempts = GREATEST(0, attempts - 1), "updatedAt" = now()
     WHERE id = $1 AND "lockedBy" = $2 AND status = 'running' AND "leaseExpiresAt" > now()`,
    [job.id, job.lockedBy],
  );
}

/** Fence the result and reschedule the same durable row in one transaction. */
export async function withOwnedJob(
  job: ServiceCheckJob,
  action: (client: PoolClient) => Promise<void | boolean>,
): Promise<boolean> {
  const client = await jobDatabase().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT d.id FROM "Dashboard" d JOIN "Service" s ON s."dashboardId" = d.id
      WHERE s.id = $1 FOR UPDATE OF d`, [job.serviceId]);
    const service = await client.query('SELECT id FROM "Service" WHERE id = $1 FOR UPDATE', [job.serviceId]);
    if (service.rowCount === 0) { await client.query('ROLLBACK'); return false; }
    const owned = await client.query(
      `SELECT id FROM "ServiceCheckJob" WHERE id = $1 AND "lockedBy" = $2
       AND status = 'running' AND "leaseExpiresAt" > clock_timestamp() FOR UPDATE`, [job.id, job.lockedBy],
    );
    if (owned.rowCount === 0) { await client.query('ROLLBACK'); return false; }
    const accepted = await action(client);
    await client.query(
      `UPDATE "ServiceCheckJob" j SET status = 'pending', "completedAt" = now(), "updatedAt" = now(),
         "availableAt" = CASE WHEN $2::boolean THEN clock_timestamp() ELSE clock_timestamp()
           + CASE WHEN j.kind = 'availability' THEN d."checkIntervalSeconds"
             ELSE d."screenshotIntervalSeconds" END * interval '1 second' END,
         attempts = 0, "lockedBy" = NULL, "leaseExpiresAt" = NULL, "lastError" = NULL
       FROM "Service" s JOIN "Dashboard" d ON d.id = s."dashboardId"
       WHERE j.id = $1 AND s.id = j."serviceId"`, [job.id, accepted === false],
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
