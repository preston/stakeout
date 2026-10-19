import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { readConfig } from './config.ts';
import { assertDatabaseReady, DatabaseNotReadyError } from './db/migrate.ts';
import { executeJob } from './jobs/executor.ts';
import { claimNextJob, closeJobDatabase, configureJobDatabase, jobDatabase, pruneFinishedJobs, recoverExpiredJobs,
  reconcileHistories, scheduleDueServiceJobs, type JobKind } from './jobs/queue.ts';
import { pruneHistory } from './history/recording.ts';

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
  const consumer = async (kind: JobKind, index: number) => {
    while (!signal.aborted) {
      try {
        const job = await claimNextJob(`${identity}:${kind}:${index}`, configuration.jobLeaseMs, kind);
        if (job) {
          await executeJob(job, configuration, { signal, leaseMs: configuration.jobLeaseMs });
        } else {
          await sleep(configuration.jobPollIntervalMs, signal);
        }
      } catch (error) {
        console.error(`${kind} worker failed:`, error instanceof Error ? error.message : String(error));
        await sleep(configuration.jobPollIntervalMs, signal);
      }
    }
  };
  const maintenance = async () => {
    let lastPruneAt = 0;
    let lastReconcileAt = 0;
    while (!signal.aborted) {
      try {
        await recoverExpiredJobs();
        await scheduleDueServiceJobs();
        if (Date.now() - lastReconcileAt >= 5000) {
          await reconcileHistories();
          lastReconcileAt = Date.now();
        }
        if (Date.now() - lastPruneAt >= configuration.historyPruneIntervalMs) {
          await pruneFinishedJobs();
          await pruneHistory(jobDatabase(), configuration.historyPruneBatchSize);
          lastPruneAt = Date.now();
        }
      } catch (error) {
        console.error('Monitoring maintenance failed:', error instanceof Error ? error.message : String(error));
      }
      await sleep(configuration.jobPollIntervalMs, signal);
    }
  };
  console.log(`stakeout-worker started (${configuration.workerConcurrency} availability, ${configuration.screenshotWorkerConcurrency} screenshot consumers)`);
  try {
    await Promise.all([
      maintenance(),
      ...Array.from({ length: configuration.workerConcurrency }, (_, index) => consumer('availability', index)),
      ...Array.from({ length: configuration.screenshotWorkerConcurrency }, (_, index) => consumer('screenshot', index)),
    ]);
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
