import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

export const STALE_CHECK_MS = 60_000;
export const DEFAULT_LEASE_MS = 90_000;

let pool: Pool | undefined;
let configuredDatabaseUrl: string | undefined;

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
  if (current) await current.end();
}

export interface ServiceCheckJob {
  id: string;
  service_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  locked_by: string | null;
  attempts: number;
  max_attempts: number;
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
  // This partial unique conflict target matches the migration's one-live-job index.
  // Check freshness in SQL rather than relying on a caller's potentially old read.
  const result = await jobDatabase().query(
    `INSERT INTO service_check_jobs (id, service_id, status, available_at, created_at, updated_at)
     SELECT gen_random_uuid(), s.id, 'pending', now(), now(), now()
     FROM services s
     WHERE ($1::text = 'all' OR ($1 = 'service' AND s.id = $2::uuid)
       OR ($1 = 'dashboard' AND s.dashboard_id = $2::uuid))
       AND (s.checked_at IS NULL OR s.checked_at < (now() AT TIME ZONE 'UTC') - $3 * interval '1 millisecond')
     ON CONFLICT (service_id) WHERE status IN ('pending', 'running') DO NOTHING`,
    [filter, id, maxAgeMs],
  );
  return result.rowCount ?? 0;
}

export async function enqueueServiceCheck(
  serviceId: string,
  options: { maxAgeMs?: number } = {},
): Promise<boolean> {
  return (await enqueueMatchingServices('service', serviceId, options.maxAgeMs ?? STALE_CHECK_MS)) > 0;
}

/** Enqueue every stale dashboard service, independently of list filtering/sorting. */
export function enqueueDashboardChecks(dashboardId: string, maxAgeMs = STALE_CHECK_MS): Promise<number> {
  return enqueueMatchingServices('dashboard', dashboardId, maxAgeMs);
}

/** Manual sweep only: the worker never schedules new monitoring work itself. */
export function enqueueStaleServiceChecks(maxAgeMs = STALE_CHECK_MS): Promise<number> {
  return enqueueMatchingServices('all', null, maxAgeMs);
}

export function enqueueChecksOlderThanOneMinute(): Promise<number> {
  return enqueueStaleServiceChecks(STALE_CHECK_MS);
}

export function enqueueChecksOlderThanFiveMinutes(): Promise<number> {
  return enqueueStaleServiceChecks(5 * STALE_CHECK_MS);
}

export async function recoverExpiredJobs(): Promise<number> {
  const result = await jobDatabase().query(
    `UPDATE service_check_jobs
     SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
       available_at = now(), locked_by = NULL, lease_expires_at = NULL,
       last_error = 'Worker lease expired', updated_at = now(),
       completed_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
     WHERE status = 'running' AND lease_expires_at <= now()`,
  );
  return result.rowCount ?? 0;
}

/** Bound queue history while keeping seven days of terminal jobs for diagnostics. */
export async function pruneFinishedJobs(): Promise<number> {
  const result = await jobDatabase().query(
    `DELETE FROM service_check_jobs WHERE id IN (
       SELECT id FROM service_check_jobs
       WHERE status IN ('completed', 'failed') AND completed_at < now() - interval '7 days'
       ORDER BY completed_at LIMIT 1000 FOR UPDATE SKIP LOCKED
     )`,
  );
  return result.rowCount ?? 0;
}

export async function claimNextJob(
  workerId: string,
  leaseMs = DEFAULT_LEASE_MS,
): Promise<ServiceCheckJob | null> {
  // A unique execution token prevents a recovered claim from accepting writes or
  // heartbeats belonging to an older execution, even on the same worker process.
  const claimToken = `${workerId}:${randomUUID()}`;
  const result = await jobDatabase().query<ServiceCheckJob>(
    `UPDATE service_check_jobs j
     SET status = 'running', locked_by = $1, lease_expires_at = now() + $2 * interval '1 millisecond',
       attempts = attempts + 1, updated_at = now()
     WHERE j.id = (
       SELECT id FROM service_check_jobs
       WHERE status = 'pending' AND available_at <= now()
       ORDER BY available_at, created_at, id
       FOR UPDATE SKIP LOCKED LIMIT 1
     ) RETURNING j.*`,
    [claimToken, leaseMs],
  );
  return result.rows[0] ?? null;
}

export async function heartbeatJob(job: ServiceCheckJob, leaseMs = DEFAULT_LEASE_MS): Promise<boolean> {
  const result = await jobDatabase().query(
    `UPDATE service_check_jobs SET lease_expires_at = now() + $3 * interval '1 millisecond', updated_at = now()
     WHERE id = $1 AND locked_by = $2 AND status = 'running' AND lease_expires_at > now()`,
    [job.id, job.locked_by, leaseMs],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function failJob(job: ServiceCheckJob, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await jobDatabase().query(
    `UPDATE service_check_jobs
     SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
       available_at = now() + LEAST(60000, 1000 * power(2, GREATEST(attempts - 1, 0))) * interval '1 millisecond',
       locked_by = NULL, lease_expires_at = NULL, last_error = $3, updated_at = now(),
       completed_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
     WHERE id = $1 AND locked_by = $2 AND status = 'running' AND lease_expires_at > now()`,
    [job.id, job.locked_by, message.slice(0, 2000)],
  );
}

export async function releaseJob(job: ServiceCheckJob): Promise<void> {
  await jobDatabase().query(
    `UPDATE service_check_jobs SET status = 'pending', available_at = now(),
       locked_by = NULL, lease_expires_at = NULL, attempts = GREATEST(0, attempts - 1), updated_at = now()
     WHERE id = $1 AND locked_by = $2 AND status = 'running' AND lease_expires_at > now()`,
    [job.id, job.locked_by],
  );
}

/** Keep the lease locked while committing a result so a reaper cannot race it. */
export async function withOwnedJob(
  job: ServiceCheckJob,
  action: (client: PoolClient) => Promise<void>,
): Promise<boolean> {
  const client = await jobDatabase().connect();
  try {
    await client.query('BEGIN');
    // API deletes acquire the service row before cascading into its job rows.
    // Use the same order so a completion and deletion cannot deadlock.
    const service = await client.query('SELECT id FROM services WHERE id = $1 FOR UPDATE', [job.service_id]);
    if (service.rowCount === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    const owned = await client.query(
      `SELECT id FROM service_check_jobs
       WHERE id = $1 AND locked_by = $2 AND status = 'running' AND lease_expires_at > now()
       FOR UPDATE`,
      [job.id, job.locked_by],
    );
    if (owned.rowCount === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    await action(client);
    await client.query(
      `UPDATE service_check_jobs SET status = 'completed', completed_at = now(), updated_at = now(),
         locked_by = NULL, lease_expires_at = NULL, last_error = NULL WHERE id = $1`,
      [job.id],
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
