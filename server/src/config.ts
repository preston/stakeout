export interface Config {
  databaseUrl: string;
  port: number;
  username: string;
  password: string;
  corsOrigin: string;
  trustProxy: boolean;
  chromeUrl: string;
  chromeToken: string;
  workerConcurrency: number;
  jobLeaseMs: number;
  jobPollIntervalMs: number;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.STAKEOUT_SERVER_DATABASE_URL ?? env.DATABASE_URL ?? '';
  if (!databaseUrl) throw new Error('STAKEOUT_SERVER_DATABASE_URL is required');
  const parsed = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('Database URL must use PostgreSQL');
  if ((parsed.searchParams.get('schema') ?? 'public') !== 'public') {
    throw new Error('Stakeout currently requires the public PostgreSQL schema');
  }
  const port = positiveInteger(env.PORT ?? env.STAKEOUT_SERVER_PORT, 3000, 'PORT');
  if (port > 65535) throw new Error('PORT must be at most 65535');
  const jobLeaseMs = positiveInteger(env.STAKEOUT_SERVER_WORKER_LEASE_MS, 90_000, 'STAKEOUT_SERVER_WORKER_LEASE_MS');
  if (jobLeaseMs <= 60_000) throw new Error('STAKEOUT_SERVER_WORKER_LEASE_MS must exceed the 60 second check timeout');
  return {
    databaseUrl, port,
    username: env.STAKEOUT_SERVER_USERNAME ?? '',
    password: env.STAKEOUT_SERVER_PASSWORD ?? '',
    corsOrigin: env.STAKEOUT_SERVER_CORS_ORIGIN ?? '*',
    trustProxy: env.STAKEOUT_SERVER_TRUST_PROXY !== 'false',
    chromeUrl: env.STAKEOUT_SERVER_CHROME_URL ?? '',
    chromeToken: env.STAKEOUT_SERVER_CHROME_TOKEN ?? '',
    workerConcurrency: positiveInteger(env.STAKEOUT_SERVER_WORKER_CONCURRENCY, 3, 'STAKEOUT_SERVER_WORKER_CONCURRENCY'),
    jobLeaseMs,
    jobPollIntervalMs: positiveInteger(env.STAKEOUT_SERVER_WORKER_POLL_INTERVAL_MS, 1000, 'STAKEOUT_SERVER_WORKER_POLL_INTERVAL_MS'),
  };
}
