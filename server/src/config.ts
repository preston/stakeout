export interface Config {
  databaseUrl: string;
  port: number;
  bootstrapUsername: string;
  bootstrapPassword: string;
  production: boolean;
  corsOrigin: string;
  trustProxy: boolean | number | string;
  chromeUrl: string;
  chromeToken: string;
  workerConcurrency: number;
  screenshotWorkerConcurrency: number;
  jobLeaseMs: number;
  jobPollIntervalMs: number;
  historyPruneIntervalMs: number;
  historyPruneBatchSize: number;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function proxyTrust(value: string | undefined): boolean | number | string {
  const input = value?.trim();
  if (!input || input === 'false') return false;
  if (input === 'true') return true;
  if (/^\d+$/.test(input)) {
    const hops = Number(input);
    if (!Number.isSafeInteger(hops)) throw new Error('STAKEOUT_SERVER_TRUST_PROXY contains an invalid hop count');
    return hops;
  }
  return input;
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
  const origins = (env.STAKEOUT_SERVER_CORS_ORIGIN ?? 'http://localhost:4200').split(',').map(s => s.trim());
  for (const origin of origins) {
    if (!origin || !['http:', 'https:'].includes(new URL(origin).protocol) || new URL(origin).origin !== origin) throw new Error('STAKEOUT_SERVER_CORS_ORIGIN must contain explicit HTTP(S) origins.');
  }
  if (Boolean(env.STAKEOUT_SERVER_BOOTSTRAP_USERNAME) !== Boolean(env.STAKEOUT_SERVER_BOOTSTRAP_PASSWORD)) throw new Error('Set STAKEOUT_SERVER_BOOTSTRAP_USERNAME and STAKEOUT_SERVER_BOOTSTRAP_PASSWORD together.');
  return {
    databaseUrl, port,
    bootstrapUsername: env.STAKEOUT_SERVER_BOOTSTRAP_USERNAME ?? '',
    bootstrapPassword: env.STAKEOUT_SERVER_BOOTSTRAP_PASSWORD ?? '',
    production: env.NODE_ENV === 'production',
    corsOrigin: env.STAKEOUT_SERVER_CORS_ORIGIN ?? 'http://localhost:4200',
    trustProxy: proxyTrust(env.STAKEOUT_SERVER_TRUST_PROXY),
    chromeUrl: env.STAKEOUT_SERVER_CHROME_URL ?? '',
    chromeToken: env.STAKEOUT_SERVER_CHROME_TOKEN ?? '',
    workerConcurrency: positiveInteger(env.STAKEOUT_SERVER_WORKER_CONCURRENCY, 3, 'STAKEOUT_SERVER_WORKER_CONCURRENCY'),
    screenshotWorkerConcurrency: positiveInteger(env.STAKEOUT_SERVER_SCREENSHOT_WORKER_CONCURRENCY, 1, 'STAKEOUT_SERVER_SCREENSHOT_WORKER_CONCURRENCY'),
    jobLeaseMs,
    jobPollIntervalMs: positiveInteger(env.STAKEOUT_SERVER_WORKER_POLL_INTERVAL_MS, 1000, 'STAKEOUT_SERVER_WORKER_POLL_INTERVAL_MS'),
    historyPruneIntervalMs: positiveInteger(env.STAKEOUT_SERVER_HISTORY_PRUNE_INTERVAL_MS, 60_000, 'STAKEOUT_SERVER_HISTORY_PRUNE_INTERVAL_MS'),
    historyPruneBatchSize: positiveInteger(env.STAKEOUT_SERVER_HISTORY_PRUNE_BATCH_SIZE, 1000, 'STAKEOUT_SERVER_HISTORY_PRUNE_BATCH_SIZE'),
  };
}
