import { checkService, JOB_TIMEOUT_MS, type CheckConfiguration } from './checkService.ts';
import { DEFAULT_LEASE_MS, failJob, heartbeatJob, releaseJob, type ServiceCheckJob } from './queue.ts';

export async function executeJob(
  job: ServiceCheckJob,
  configuration: CheckConfiguration,
  options: { signal?: AbortSignal; leaseMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const controller = new AbortController();
  const shutdownSignal = options.signal;
  const shutdown = () => controller.abort(new Error('Worker is shutting down'));
  if (shutdownSignal?.aborted) shutdown();
  else shutdownSignal?.addEventListener('abort', shutdown, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('Service check exceeded its 60 second deadline')), options.timeoutMs ?? JOB_TIMEOUT_MS);
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  let heartbeatRunning = false;
  const heartbeat = setInterval(() => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    void heartbeatJob(job, leaseMs).then((owned) => {
      if (!owned) controller.abort(new Error('Service check lease was lost'));
    }).catch(() => {
      controller.abort(new Error('Service check heartbeat failed'));
    }).finally(() => { heartbeatRunning = false; });
  }, Math.max(100, Math.min(15_000, leaseMs / 3)));
  try {
    await checkService(job, configuration, controller.signal);
  } catch (error) {
    if (shutdownSignal?.aborted) await releaseJob(job);
    else await failJob(job, error);
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
    shutdownSignal?.removeEventListener('abort', shutdown);
  }
}
