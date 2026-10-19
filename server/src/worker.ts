import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { readConfig } from './config.ts';
import { assertDatabaseReady, DatabaseNotReadyError } from './db/migrate.ts';
import { executeJob } from './jobs/executor.ts';
import { claimNextJob, closeJobDatabase, configureJobDatabase, jobDatabase, pruneFinishedJobs, recoverExpiredJobs } from './jobs/queue.ts';

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Readiness only: schema adoption/migrations belong to the server entry point. */
export async function waitForDatabase(
  signal: AbortSignal,
  pollIntervalMs = 1000,
  timeoutMs = 120_000,
  databaseUrl = readConfig().databaseUrl,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastReason = 'Database is not available';
  while (!signal.aborted) {
    try {
      await assertDatabaseReady(databaseUrl);
      return;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (!(error instanceof DatabaseNotReadyError)
        && !['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', '57P03', '53300'].includes(code)) {
        throw error;
      }
      lastReason = error instanceof Error ? error.message : String(error);
      if (Date.now() >= deadline) {
        throw new Error(`Worker database readiness timed out after ${timeoutMs}ms: ${lastReason}`);
      }
      await sleep(pollIntervalMs, signal);
    }
  }
}

export async function runWorker(signal: AbortSignal): Promise<void> {
  const configuration = readConfig();
  configureJobDatabase(configuration.databaseUrl);
  await waitForDatabase(signal, configuration.jobPollIntervalMs, 120_000, configuration.databaseUrl);
  if (signal.aborted) return;
  const identity = `${hostname()}:${process.pid}`;
  let lastPruneAt = 0;
  const consumer = async (index: number) => {
    while (!signal.aborted) {
      try {
        await recoverExpiredJobs();
        if (index === 0 && Date.now() - lastPruneAt >= 60_000) {
          await pruneFinishedJobs();
          lastPruneAt = Date.now();
        }
        const job = await claimNextJob(`${identity}:${index}`, configuration.jobLeaseMs);
        if (job) {
          await executeJob(job, configuration, { signal, leaseMs: configuration.jobLeaseMs });
        } else {
          await sleep(configuration.jobPollIntervalMs, signal);
        }
      } catch (error) {
        console.error('Service check worker failed:', error instanceof Error ? error.message : String(error));
        await sleep(configuration.jobPollIntervalMs, signal);
      }
    }
  };
  console.log(`stakeout-worker started (${configuration.workerConcurrency} consumers)`);
  try {
    await Promise.all(Array.from({ length: configuration.workerConcurrency }, (_, index) => consumer(index)));
  } finally {
    await closeJobDatabase();
  }
}

export async function main(): Promise<void> {
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    await runWorker(controller.signal);
  } finally {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    await closeJobDatabase();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
