import assert from 'node:assert/strict';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { once } from 'node:events';
import { test } from 'node:test';
import sharp from 'sharp';
import { screenshotHash } from '../src/screenshots.ts';
import { bootstrapDatabase } from '../src/bootstrap.ts';
import { withPostgres } from './postgres.ts';
import {
  browserlessScreenshotUrl, checkService, CONNECT_TIMEOUT_MS, fetchScreenshot, JOB_TIMEOUT_MS,
  READ_TIMEOUT_MS, SCREENSHOT_TIMEOUT_MS, screenshotRequestBody, serviceUrl,
} from '../src/jobs/checkService.ts';
import { executeJob } from '../src/jobs/executor.ts';
import {
  claimNextJob, closeJobDatabase, configureJobDatabase, enqueueDashboardChecks,
  enqueueChecksOlderThanFiveMinutes, enqueueServiceCheck, heartbeatJob, jobDatabase,
  pruneFinishedJobs, recoverExpiredJobs, releaseJob, withOwnedJob, scheduleDueServiceJobs, reconcileHistories, type JobKind,
} from '../src/jobs/queue.ts';
import { runWorker, waitForDatabase } from '../src/worker.ts';
import { readConfig } from '../src/config.ts';

const png = await sharp({ create: { width: 1280, height: 1280, channels: 3, background: '#f8f9fa' } }).png().toBuffer();
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for worker result');
    await delay(15);
  }
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = http.createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch(() => { res.writeHead(500); res.end(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    server, port: address.port, url: `http://127.0.0.1:${address.port}`,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

test('service and Browserless URLs retain custom ports, settings, prefixes and tokens', () => {
  assert.equal(serviceUrl({ host: 'example.com', port: 8123, httpPath: '/ready?q=1' }, false).href, 'http://example.com:8123/ready?q=1');
  assert.equal(serviceUrl({ host: 'example.com', port: 8443, httpPath: '' }, true).href, 'https://example.com:8443/');
  assert.equal(serviceUrl({ host: '::1', port: 8123, httpPath: 'status' }, false).href, 'http://[::1]:8123/status');
  assert.equal(serviceUrl({ host: 'example.com', port: 0, httpPath: '/' }, true).href, 'https://example.com/');
  assert.equal(browserlessScreenshotUrl('ws://chrome:3000', 'a&b').href, 'http://chrome:3000/screenshot?token=a%26b');
  assert.equal(browserlessScreenshotUrl('wss://chrome.example/chromium/?existing=yes', 'secret').href, 'https://chrome.example/chromium/screenshot?existing=yes&token=secret');
  assert.equal(browserlessScreenshotUrl('chrome:3000/screenshot?token=existing').href, 'http://chrome:3000/screenshot?token=existing');
  assert.deepEqual(JSON.parse(screenshotRequestBody('https://example.com/')), {
    url: 'https://example.com/', viewport: { width: 1280, height: 1280 },
    options: { type: 'png' }, gotoOptions: { waitUntil: 'networkidle2', timeout: 5000 },
  });
  assert.equal(JOB_TIMEOUT_MS, 60_000);
  assert.equal(CONNECT_TIMEOUT_MS, 5_000);
  assert.equal(READ_TIMEOUT_MS, 10_000);
  assert.equal(SCREENSHOT_TIMEOUT_MS, 15_000);
});

test('worker screenshot capacity and pruning controls accept positive integers', () => {
  const env = { STAKEOUT_SERVER_DATABASE_URL: 'postgresql://unused/unused' };
  const defaults = readConfig(env);
  assert.equal(defaults.screenshotWorkerConcurrency, 1);
  assert.equal(defaults.historyPruneIntervalMs, 60_000);
  assert.equal(defaults.historyPruneBatchSize, 1000);
  const configured = readConfig({ ...env, STAKEOUT_SERVER_SCREENSHOT_WORKER_CONCURRENCY: '2',
    STAKEOUT_SERVER_HISTORY_PRUNE_INTERVAL_MS: '30000', STAKEOUT_SERVER_HISTORY_PRUNE_BATCH_SIZE: '250' });
  assert.equal(configured.screenshotWorkerConcurrency, 2);
  assert.equal(configured.historyPruneIntervalMs, 30_000);
  assert.equal(configured.historyPruneBatchSize, 250);
  for (const name of ['STAKEOUT_SERVER_SCREENSHOT_WORKER_CONCURRENCY',
    'STAKEOUT_SERVER_HISTORY_PRUNE_INTERVAL_MS', 'STAKEOUT_SERVER_HISTORY_PRUNE_BATCH_SIZE']) {
    for (const value of ['0','-1','1.2','NaN']) assert.throws(() => readConfig({ ...env, [name]: value }), /positive integer/);
  }
});

test('PostgreSQL service checks preserve availability, queue and edit semantics', { timeout: 180_000 }, async (t) => {
  await withPostgres(async (databaseUrl) => {
    configureJobDatabase(databaseUrl);
    await t.test('worker readiness never migrates an empty database and fails within its deadline', async () => {
      await assert.rejects(waitForDatabase(new AbortController().signal, 5, 30, databaseUrl), /readiness timed out/);
      assert.equal((await jobDatabase().query(`SELECT to_regclass('public._prisma_migrations') AS name`)).rows[0].name, null);
    });
    await bootstrapDatabase(databaseUrl);
    let targetHandler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> = (_req, res) => res.end('OK');
    const target = await listen((req, res) => targetHandler(req, res));
    let screenshotBody: unknown;
    let screenshotPath: string | undefined;
    let screenshotStatus = 200;
    let screenshotResult = png;
    let screenshotDelayMs = 0;
    let screenshotCalls = 0;
    const browserless = await listen(async (req, res) => {
      screenshotPath = req.url;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      screenshotBody = JSON.parse(Buffer.concat(chunks).toString());
      screenshotCalls++;
      if (screenshotDelayMs) await delay(screenshotDelayMs);
      res.writeHead(screenshotStatus, { 'Content-Type': 'image/png' });
      res.end(screenshotResult);
    });
    const configuration = { chromeUrl: `${browserless.url}/chromium`, chromeToken: 'a&b' };
    const reset = async () => {
      await jobDatabase().query('DELETE FROM "Service"');
      await jobDatabase().query('DELETE FROM "Dashboard"');
      targetHandler = (_req, res) => res.end('OK');
      screenshotStatus = 200;
      screenshotResult = png;
      screenshotDelayMs = 0;
      screenshotCalls = 0;
    };
    const createDashboard = async () => {
      const result = await jobDatabase().query<{ id: string }>(
        `INSERT INTO "Dashboard"(name, "createdAt", "updatedAt") VALUES ('Example', now(), '2020-01-01') RETURNING id`,
      );
      return result.rows[0]!.id;
    };
    const createService = async (dashboardId: string, name = 'Service') => {
      const result = await jobDatabase().query<{ id: string }>(
        `INSERT INTO "Service"("dashboardId", name, host, port, "httpPath", "httpPreview", "createdAt", "updatedAt")
         VALUES ($1, $2, '127.0.0.1', $3, '/health', false, now(), now()) RETURNING id`,
        [dashboardId, name, target.port],
      );
      return result.rows[0]!.id;
    };
    const claimed = async (serviceId: string, leaseMs = 90_000, kind: JobKind = 'availability') => {
      if (kind === 'availability') await enqueueServiceCheck(serviceId);
      else {
        await jobDatabase().query(`UPDATE "Dashboard" SET "screenshotDemandUntil"=now()+interval '90 seconds'
          WHERE id=(SELECT "dashboardId" FROM "Service" WHERE id=$1)`, [serviceId]);
        await scheduleDueServiceJobs();
      }
      await jobDatabase().query(`UPDATE "ServiceCheckJob" SET "availableAt"=now() WHERE "serviceId"=$1 AND kind=$2`, [serviceId, kind]);
      const job = await claimNextJob('test-worker', leaseMs, kind);
      assert.ok(job);
      assert.equal(job.serviceId, serviceId);
      return job;
    };
    const service = async (id: string) => (await jobDatabase().query('SELECT * FROM "Service" WHERE id = $1', [id])).rows[0];
    try {
      await t.test('deduplicates concurrent enqueue and claims; lists enqueue all stale dashboard services', async () => {
        await reset();
        const dashboard = await createDashboard();
        const first = await createService(dashboard, 'First');
        const second = await createService(dashboard, 'Second');
        const fresh = await createService(dashboard, 'Fresh');
        await jobDatabase().query(`UPDATE "Service" SET "checkedAt" = now() - interval '59 seconds' WHERE id = $1`, [fresh]);
        const attempts = await Promise.all(Array.from({ length: 20 }, () => enqueueServiceCheck(first)));
        assert.equal(attempts.filter(Boolean).length, 1);
        assert.equal(await enqueueDashboardChecks(dashboard), 1);
        const jobs = await Promise.all([claimNextJob('one'), claimNextJob('two'), claimNextJob('three')]);
        assert.equal(jobs.filter(Boolean).length, 2);
        assert.deepEqual(new Set(jobs.filter(Boolean).map((job) => job!.serviceId)), new Set([first, second]));
        assert.equal(await enqueueServiceCheck(first), false);
        await jobDatabase().query(`UPDATE "Service" SET "checkedAt" = now() - interval '2 minutes' WHERE id = $1`, [fresh]);
        assert.equal(await enqueueChecksOlderThanFiveMinutes(), 0);
        assert.equal(await enqueueServiceCheck(fresh), true);
      });

      await t.test('custom HTTP port, 302 availability without following redirects, PNG preview and dashboard touch', async () => {
        await reset();
        const dashboard = await createDashboard();
        const id = await createService(dashboard);
        await jobDatabase().query(`UPDATE "Service" SET "httpPreview" = true WHERE id = $1`, [id]);
        const paths: string[] = [];
        targetHandler = (req, res) => {
          paths.push(req.url ?? '');
          res.writeHead(302, { Location: '/never-follow' });
          res.end();
        };
        await executeJob(await claimed(id), configuration);
        await executeJob(await claimed(id, 90_000, 'screenshot'), configuration);
        const row = await service(id);
        assert.equal(row.httpPathLast, true);
        assert.equal(row.httpsPathLast, false);
        assert.ok(row.checkedAt);
        assert.deepEqual(row.httpScreenshot, png);
        assert.equal(row.httpScreenshotHash, screenshotHash(png));
        const preview = await sharp(row.httpScreenshotPreview).metadata();
        assert.equal(preview.format, 'webp');
        assert.equal(preview.width, 600);
        assert.equal(preview.height, 600);
        assert.deepEqual(paths, ['/health']);
        assert.equal(screenshotPath, '/chromium/screenshot?token=a%26b');
        assert.deepEqual(screenshotBody, JSON.parse(screenshotRequestBody(`${target.url}/health`)));
        const touched = await jobDatabase().query('SELECT "updatedAt" FROM "Dashboard" WHERE id = $1', [dashboard]);
        assert.ok(touched.rows[0].updatedAt.getTime() > new Date('2020-01-01').getTime());
        assert.equal(await enqueueServiceCheck(id), false);
      });

      await t.test('enqueue skips services being deleted or locked and retries them on a later poll', async () => {
        await reset();
        const dashboard = await createDashboard();
        const deleted = await createService(dashboard, 'Being deleted');
        const enqueueWithoutWaiting = async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              enqueueDashboardChecks(dashboard),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('Enqueue waited on a locked service')), 1000);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        };
        const deletion = await jobDatabase().connect();
        try {
          await deletion.query('BEGIN');
          await deletion.query('DELETE FROM "Service" WHERE id=$1', [deleted]);
          // This must return before COMMIT: FK checks on an unlocked snapshot
          // used to wait here and then fail23503 when deletion committed.
          assert.equal(await enqueueWithoutWaiting(), 0);
          await deletion.query('COMMIT');
          assert.equal(await enqueueDashboardChecks(dashboard), 0);
        } finally {
          await deletion.query('ROLLBACK');
          deletion.release();
        }
        const edited = await createService(dashboard, 'Being edited');
        const edit = await jobDatabase().connect();
        try {
          await edit.query('BEGIN');
          // Name belongs to the unique dashboard/name key, so this ordinary
          // edit takes a row lock conflicting with the queue's KEY SHARE.
          await edit.query(`UPDATE "Service" SET name='Edited' WHERE id=$1`, [edited]);
          assert.equal(await enqueueWithoutWaiting(), 0);
          await edit.query('ROLLBACK');
          assert.equal(await enqueueDashboardChecks(dashboard), 1);
          assert.equal(await enqueueDashboardChecks(dashboard), 0);
        } finally {
          await edit.query('ROLLBACK');
          edit.release();
        }
      });

      await t.test('unavailable services and non-PNG Browserless errors clear old screenshots', async () => {
        await reset();
        const id = await createService(await createDashboard());
        await jobDatabase().query(`UPDATE "Service" SET "httpPreview" = true, "httpScreenshot" = $2 WHERE id = $1`, [id, png]);
        targetHandler = (_req, res) => { res.writeHead(404); res.end('missing'); };
        screenshotResult = Buffer.from('not a PNG');
        await executeJob(await claimed(id), configuration);
        await executeJob(await claimed(id, 90_000, 'screenshot'), configuration);
        let row = await service(id);
        assert.equal(row.httpPathLast, false);
        assert.equal(row.httpScreenshot, null);
        assert.equal(row.httpScreenshotHash, null);
        assert.equal(row.httpScreenshotPreview, null);
        assert.ok(row.checkedAt);
        screenshotStatus = 500;
        screenshotResult = png;
        assert.equal(await fetchScreenshot('about:blank', configuration, AbortSignal.timeout(1000)), null);
        await jobDatabase().query(`UPDATE "Service" SET "checkedAt" = NULL, http = false, https = false, "httpScreenshot" = $2 WHERE id = $1`, [id, png]);
        assert.equal(await enqueueServiceCheck(id), false);
        assert.equal(await claimNextJob('unconfigured'), null);
        row = await service(id);
        assert.equal(row.checkedAt, null);
        assert.equal(row.httpPathLast, false);
      });

      await t.test('streaming HTTP responses record status without waiting for or retaining the body', async () => {
        for (const status of [200,503]) {
          await reset();
          const id = await createService(await createDashboard());
          let disconnected = false;
          targetHandler = (_req,res) => {
            res.writeHead(status, { 'Content-Type': 'text/event-stream' });
            res.write('data: still streaming\n\n');
            const timer = setInterval(() => res.write('data: still streaming\n\n'),10);
            res.once('close', () => { disconnected = true; clearInterval(timer); });
          };
          const job = await claimed(id);
          await executeJob(job,configuration,{ timeoutMs:1000 });
          assert.ok((await service(id)).checkedAt,'the response is an accepted observation');
          const period = (await jobDatabase().query('SELECT state,"httpStatus" FROM "AvailabilityInterval" WHERE "serviceId"=$1 AND "endedAt" IS NULL',[id])).rows[0];
          assert.equal(period.state,status===200?'up':'down');
          assert.equal(period.httpStatus,status);
          const scheduled = (await jobDatabase().query('SELECT attempts,"lastError" FROM "ServiceCheckJob" WHERE id=$1',[job.id])).rows[0];
          assert.equal(scheduled.attempts,0); assert.equal(scheduled.lastError,null);
          await until(async()=>disconnected);
        }
      });

      await t.test('HTTPS validates a trusted certificate, uses custom ports and prefers HTTPS for previews', async () => {
        await reset();
        const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
        const key = privateKey.export({ type: 'pkcs8', format: 'pem' });
        const cert = execFileSync('openssl', [
          'req', '-new', '-x509', '-key', '/dev/stdin', '-subj', '/CN=127.0.0.1',
          '-addext', 'subjectAltName=IP:127.0.0.1', '-days', '1',
        ], { input: key, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
        const originalCertificates = getCACertificates('default');
        const secure = https.createServer({ key, cert }, (_req, res) => { res.writeHead(204); res.end(); });
        secure.listen(0, '127.0.0.1');
        await once(secure, 'listening');
        const address = secure.address();
        assert.ok(address && typeof address !== 'string');
        const id = await createService(await createDashboard());
        try {
          setDefaultCACertificates([...originalCertificates, cert]);
          await jobDatabase().query(`UPDATE "Service" SET port=$2, http=false, https=true, "httpPreview"=true WHERE id=$1`, [id, address.port]);
          await executeJob(await claimed(id), configuration);
          await executeJob(await claimed(id, 90_000, 'screenshot'), configuration);
          const row = await service(id);
          assert.equal(row.httpsPathLast, true);
          assert.equal(row.httpPathLast, false);
          assert.deepEqual(row.httpScreenshot, png);
          assert.deepEqual(screenshotBody, JSON.parse(screenshotRequestBody(`https://127.0.0.1:${address.port}/health`)));
        } finally {
          setDefaultCACertificates(originalCertificates);
          secure.closeAllConnections();
          await new Promise<void>((resolve) => secure.close(() => resolve()));
        }
      });

      await t.test('worker skips a queued job whose service was checked after enqueue', async () => {
        await reset();
        const id = await createService(await createDashboard());
        const job = await claimed(id);
        await jobDatabase().query('UPDATE "Service" SET "checkedAt" = now() WHERE id = $1', [id]);
        let calls = 0;
        targetHandler = (_req, res) => { calls++; res.end(); };
        await executeJob(job, configuration);
        assert.equal(calls, 0);
        assert.equal((await jobDatabase().query('SELECT status FROM "ServiceCheckJob" WHERE id=$1', [job.id])).rows[0].status, 'pending');
      });

      await t.test('editing or deleting during network I/O cannot overwrite or resurrect records', async () => {
        await reset();
        const dashboard = await createDashboard();
        let id = await createService(dashboard);
        let release!: () => void;
        let started!: () => void;
        let requestStarted = new Promise<void>((resolve) => { started = resolve; });
        targetHandler = async (_req, res) => { started(); await new Promise<void>((resolve) => { release = resolve; }); res.end(); };
        let execution = executeJob(await claimed(id), configuration);
        await requestStarted;
        await jobDatabase().query(`UPDATE "Service" SET name = 'Edited', "checkedAt" = NULL, "httpPathLast" = false,
          "httpPath" = '/edited', "configRevision" = "configRevision" + 1, "updatedAt" = "updatedAt" WHERE id = $1`, [id]);
        release();
        await execution;
        const edited = await service(id);
        assert.equal(edited.name, 'Edited');
        assert.equal(edited.checkedAt, null);
        assert.equal(edited.httpPathLast, false);
        assert.equal(await enqueueServiceCheck(id), false);
        assert.ok(await claimNextJob('edited'));
        await jobDatabase().query('DELETE FROM "Service" WHERE id=$1', [id]);
        id = await createService(dashboard, 'Deleted');
        requestStarted = new Promise<void>((resolve) => { started = resolve; });
        execution = executeJob(await claimed(id), configuration);
        await requestStarted;
        await jobDatabase().query('DELETE FROM "Service" WHERE id=$1', [id]);
        release();
        await execution;
        assert.equal(await service(id), undefined);
        assert.equal((await jobDatabase().query('SELECT count(*) FROM "ServiceCheckJob"')).rows[0].count, '0');
      });

      await t.test('expired leases recover once, reject old execution writes and exhaust retries', async () => {
        await reset();
        const id = await createService(await createDashboard());
        const old = await claimed(id);
        await jobDatabase().query(`UPDATE "ServiceCheckJob" SET "leaseExpiresAt" = now() - interval '1 second' WHERE id=$1`, [old.id]);
        assert.equal(await recoverExpiredJobs(), 1);
        const current = await claimNextJob('same-worker');
        assert.ok(current);
        assert.notEqual(current.lockedBy, old.lockedBy);
        assert.equal(current.attempts, 2);
        assert.equal(await heartbeatJob(old), false);
        await releaseJob(old);
        assert.equal(await checkService(old, configuration, AbortSignal.timeout(1000)), false);
        assert.equal((await service(id)).checkedAt, null);
        await jobDatabase().query(`UPDATE "ServiceCheckJob" SET attempts="maxAttempts",
          "leaseExpiresAt"=now()-interval '1 second' WHERE id=$1`, [current.id]);
        assert.equal(await recoverExpiredJobs(), 1);
        assert.equal((await jobDatabase().query('SELECT status FROM "ServiceCheckJob" WHERE id=$1', [old.id])).rows[0].status, 'pending');
        assert.equal(await claimNextJob('other'), null);
        await jobDatabase().query('UPDATE "ServiceCheckJob" SET "availableAt"=now() WHERE id=$1', [old.id]);
        assert.ok(await claimNextJob('recovered'));
      });

      await t.test('completion waits for a service before locking its job, allowing concurrent deletion', async () => {
        await reset();
        const id = await createService(await createDashboard());
        const job = await claimed(id);
        const deletion = await jobDatabase().connect();
        let transactionOpen = false;
        let completion: Promise<boolean> | undefined;
        let ranAction = false;
        try {
          await deletion.query('BEGIN');
          transactionOpen = true;
          await deletion.query('SELECT id FROM "Service" WHERE id=$1 FOR UPDATE', [id]);
          const ownerPid = (await deletion.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          completion = withOwnedJob(job, async (client) => {
            ranAction = true;
            await client.query('UPDATE "Service" SET "checkedAt"=now() WHERE id=$1', [id]);
          });
          // Observe the actual lock wait instead of relying on timer scheduling.
          const deadline = Date.now() + 5000;
          while (true) {
            const waiting = await jobDatabase().query(`SELECT 1 FROM pg_stat_activity
              WHERE wait_event_type='Lock' AND query LIKE '%"Service"%'
                AND $1::integer = ANY(pg_blocking_pids(pid))`, [ownerPid]);
            if (waiting.rowCount) break;
            assert.ok(Date.now() < deadline, 'Completion should be waiting on the service row');
          }
          // With the old job-first order this fails NOWAIT because completion
          // holds the job lock while waiting for the service held by deletion.
          await deletion.query('SELECT id FROM "ServiceCheckJob" WHERE id=$1 FOR UPDATE NOWAIT', [job.id]);
          await deletion.query('DELETE FROM "Service" WHERE id=$1', [id]);
          await deletion.query('COMMIT');
          transactionOpen = false;
          assert.equal(await completion, false);
          assert.equal(ranAction, false);
          assert.equal((await jobDatabase().query('SELECT count(*) FROM "ServiceCheckJob" WHERE id=$1', [job.id])).rows[0].count, '0');
        } finally {
          if (transactionOpen) await deletion.query('ROLLBACK');
          deletion.release();
          if (completion) await completion.catch(() => {});
        }
      });

      await t.test('a lease expiring while completion waits on row locks cannot commit late results', async () => {
        await reset();
        const id = await createService(await createDashboard());
        const job = await claimed(id);
        const edit = await jobDatabase().connect();
        let completion: Promise<boolean> | undefined;
        try {
          await edit.query('BEGIN');
          await edit.query('SELECT id FROM "Service" WHERE id=$1 FOR UPDATE', [id]);
          const ownerPid = (await edit.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          completion = withOwnedJob(job, async (client) => {
            await client.query('UPDATE "Service" SET "checkedAt"=now() WHERE id=$1', [id]);
          });
          await until(async () => Boolean((await jobDatabase().query(`SELECT 1 FROM pg_stat_activity
            WHERE wait_event_type='Lock' AND $1::integer=ANY(pg_blocking_pids(pid))`, [ownerPid])).rowCount));
          await delay(10);
          await jobDatabase().query(`UPDATE "ServiceCheckJob" SET "leaseExpiresAt"=clock_timestamp()-interval '1 millisecond' WHERE id=$1`, [job.id]);
          await edit.query('COMMIT');
          assert.equal(await completion, false);
          assert.equal((await service(id)).checkedAt, null);
          assert.equal(await recoverExpiredJobs(), 1);
        } finally {
          await edit.query('ROLLBACK');
          edit.release();
          if (completion) await completion.catch(() => {});
        }
      });

      await t.test('deadline retries and shutdown releases claimed work without writing a result', async () => {
        await reset();
        const id = await createService(await createDashboard());
        targetHandler = () => {};
        const first = await claimed(id);
        await executeJob(first, configuration, { timeoutMs: 40 });
        let row = (await jobDatabase().query('SELECT * FROM "ServiceCheckJob" WHERE id=$1', [first.id])).rows[0];
        assert.equal(row.status, 'pending');
        assert.equal(row.attempts, 1);
        assert.match(row.lastError, /deadline/);
        assert.equal((await service(id)).checkedAt, null);
        await jobDatabase().query('UPDATE "ServiceCheckJob" SET "availableAt"=now() WHERE id=$1', [first.id]);
        const second = await claimNextJob('shutdown');
        assert.ok(second);
        const stop = new AbortController();
        const execution = executeJob(second, configuration, { signal: stop.signal });
        await delay(20);
        stop.abort();
        await execution;
        row = (await jobDatabase().query('SELECT * FROM "ServiceCheckJob" WHERE id=$1', [first.id])).rows[0];
        assert.equal(row.status, 'pending');
        assert.equal(row.attempts, 1);
        await jobDatabase().query('UPDATE "ServiceCheckJob" SET "availableAt"=now(), attempts="maxAttempts"-1 WHERE id=$1', [first.id]);
        const final = await claimNextJob('last');
        assert.ok(final);
        await executeJob(final, configuration, { timeoutMs: 25 });
        assert.equal((await jobDatabase().query('SELECT status FROM "ServiceCheckJob" WHERE id=$1', [first.id])).rows[0].status, 'pending');
      });

      await t.test('heartbeat keeps a slow check owned while another worker performs lease recovery', async () => {
        await reset();
        const id = await createService(await createDashboard());
        targetHandler = async (_req, res) => { await delay(650); res.end(); };
        const execution = executeJob(await claimed(id, 300), configuration, { leaseMs: 300 });
        await delay(420);
        assert.equal(await recoverExpiredJobs(), 0);
        await execution;
        assert.ok((await service(id)).checkedAt);
      });

      await t.test('housekeeping recycles terminal rows without growing queue history', async () => {
        await reset();
        const id = await createService(await createDashboard());
        await jobDatabase().query(`INSERT INTO "ServiceCheckJob"("serviceId",kind,status,"completedAt")
          VALUES ($1,'availability','completed',now()-interval '8 days'),
            ($1,'screenshot','failed',now()-interval '8 days')`, [id]);
        assert.equal(await pruneFinishedJobs(), 2);
        assert.equal(await pruneFinishedJobs(), 0);
        assert.equal((await jobDatabase().query('SELECT count(*) FROM "ServiceCheckJob"')).rows[0].count, '2');
        assert.equal((await jobDatabase().query(`SELECT count(*) FROM "ServiceCheckJob" WHERE status='pending'`)).rows[0].count, '2');
      });

      await t.test('checks reuse durable rows and unchanged availability extends a single interval', async () => {
        await reset();
        const id = await createService(await createDashboard());
        await executeJob(await claimed(id), configuration);
        const firstJob = (await jobDatabase().query('SELECT * FROM "ServiceCheckJob" WHERE "serviceId"=$1', [id])).rows[0];
        assert.equal(firstJob.status, 'pending');
        assert.equal(firstJob.attempts, 0);
        assert.ok(firstJob.availableAt.getTime() > Date.now() + 50_000);
        await jobDatabase().query(`UPDATE "Service" SET "checkedAt"=now()-interval '2 minutes' WHERE id=$1`, [id]);
        await executeJob(await claimed(id), configuration);
        assert.equal((await jobDatabase().query('SELECT count(*) FROM "ServiceCheckJob" WHERE "serviceId"=$1', [id])).rows[0].count, '1');
        assert.equal((await jobDatabase().query('SELECT count(*) FROM "AvailabilityInterval" WHERE "serviceId"=$1 AND state=$2', [id, 'up'])).rows[0].count, '1');
        assert.equal((await jobDatabase().query('SELECT id FROM "ServiceCheckJob" WHERE "serviceId"=$1', [id])).rows[0].id, firstJob.id);
      });

      await t.test('dashboard cadence and pauses govern polling; screenshots require shared live demand', async () => {
        await reset();
        const dashboard = await createDashboard();
        const id = await createService(dashboard);
        await jobDatabase().query(`UPDATE "Dashboard" SET "checkIntervalSeconds"=300 WHERE id=$1`, [dashboard]);
        await jobDatabase().query(`UPDATE "Service" SET "checkedAt"=now()-interval '2 minutes', "httpPreview"=true WHERE id=$1`, [id]);
        assert.equal(await enqueueServiceCheck(id), false);
        assert.equal(await enqueueDashboardChecks(dashboard), 0);
        assert.equal(await scheduleDueServiceJobs(), 1);
        assert.equal(await claimNextJob('cadence'), null);
        assert.equal(await claimNextJob('no-viewers', 90_000, 'screenshot'), null);
        await jobDatabase().query(`UPDATE "Dashboard" SET "monitoringEnabled"=false,
          "screenshotDemandUntil"=now()+interval '90 seconds', "monitoringRevision"="monitoringRevision"+1 WHERE id=$1`, [dashboard]);
        assert.equal(await enqueueDashboardChecks(dashboard), 0);
        assert.equal(await scheduleDueServiceJobs(), 1);
        assert.equal(await scheduleDueServiceJobs(), 0);
        assert.equal(await claimNextJob('paused'), null);
        const shot = await claimNextJob('viewer', 90_000, 'screenshot');
        assert.ok(shot);
        await executeJob(shot, configuration);
        assert.equal(screenshotCalls, 1);
        assert.ok((await service(id)).screenshotCheckedAt);
        await jobDatabase().query(`UPDATE "Dashboard" SET "screenshotDemandUntil"=now()-interval '1 second' WHERE id=$1`, [dashboard]);
        await jobDatabase().query(`UPDATE "Service" SET "screenshotCheckedAt"=NULL WHERE id=$1`, [id]);
        await jobDatabase().query(`UPDATE "ServiceCheckJob" SET "availableAt"=now() WHERE "serviceId"=$1`, [id]);
        assert.equal(await claimNextJob('expired-viewers', 90_000, 'screenshot'), null);
      });

      await t.test('requested checks bypass the old cadence once and retain the last valid observation', async () => {
        await reset();
        const dashboard = await createDashboard();
        const id = await createService(dashboard);
        await executeJob(await claimed(id),configuration);
        const previous = await service(id);
        await jobDatabase().query('UPDATE "Dashboard" SET "checkIntervalSeconds"=300,"monitoringRevision"="monitoringRevision"+1 WHERE id=$1',[dashboard]);
        await jobDatabase().query('UPDATE "Service" SET "availabilityCheckRequestedAt"=now() WHERE id=$1',[id]);
        await jobDatabase().query('UPDATE "ServiceCheckJob" SET "availableAt"=now() WHERE "serviceId"=$1',[id]);
        assert.equal((await service(id)).checkedAt.getTime(),previous.checkedAt.getTime());
        const job = await claimNextJob('cadence-change'); assert.ok(job);
        await executeJob(job,configuration);
        const checked = await service(id);
        assert.equal(checked.availabilityCheckRequestedAt,null);
        assert.ok(checked.checkedAt>=previous.checkedAt);
        const periods = (await jobDatabase().query('SELECT "checkIntervalSeconds" FROM "AvailabilityInterval" WHERE "serviceId"=$1 AND state=$2',[id,'up'])).rows;
        assert.equal(periods.length,1); assert.equal(periods[0].checkIntervalSeconds,300);
        assert.equal(await claimNextJob('already-refreshed'),null);
        await jobDatabase().query('UPDATE "Service" SET "availabilityCheckRequestedAt"=now() WHERE id=$1',[id]);
        await jobDatabase().query('UPDATE "Dashboard" SET "monitoringEnabled"=false WHERE id=$1',[dashboard]);
        await jobDatabase().query('UPDATE "ServiceCheckJob" SET "availableAt"=now() WHERE "serviceId"=$1',[id]);
        assert.equal(await claimNextJob('paused-request'),null);
      });

      await t.test('a cadence edit during a request keeps the new check pending until a fresh result is accepted', async () => {
        await reset();
        const dashboard = await createDashboard();
        const id = await createService(dashboard);
        let started!: () => void; let release!: () => void;
        const requestStarted = new Promise<void>(resolve=>{started=resolve;});
        targetHandler = async (_req,res) => { started(); await new Promise<void>(resolve=>{release=resolve;}); res.end(); };
        const execution = executeJob(await claimed(id),configuration);
        await requestStarted;
        await jobDatabase().query('UPDATE "Dashboard" SET "checkIntervalSeconds"=300,"monitoringRevision"="monitoringRevision"+1 WHERE id=$1',[dashboard]);
        await jobDatabase().query('UPDATE "Service" SET "availabilityCheckRequestedAt"=now() WHERE id=$1',[id]);
        release(); await execution;
        assert.ok((await service(id)).availabilityCheckRequestedAt);
        assert.equal((await service(id)).checkedAt,null);
        const next = await claimNextJob('new-cadence'); assert.ok(next);
        targetHandler = (_req,res)=>res.end();
        await executeJob(next,configuration);
        assert.equal((await service(id)).availabilityCheckRequestedAt,null);
        assert.ok((await service(id)).checkedAt);
      });

      await t.test('concurrent screenshot writes cannot invalidate an availability observation', async () => {
        await reset();
        const dashboard = await createDashboard();
        const id = await createService(dashboard);
        await jobDatabase().query(`UPDATE "Service" SET "httpPreview"=true WHERE id=$1`, [id]);
        let started!: () => void;
        let release!: () => void;
        const requestStarted = new Promise<void>((resolve) => { started = resolve; });
        targetHandler = async (_req, res) => { started(); await new Promise<void>((resolve) => { release = resolve; }); res.end(); };
        const availability = executeJob(await claimed(id), configuration);
        await requestStarted;
        await executeJob(await claimed(id, 90_000, 'screenshot'), configuration);
        assert.ok((await service(id)).screenshotCheckedAt);
        release();
        await availability;
        assert.equal((await service(id)).httpPathLast, true);
        assert.ok((await service(id)).checkedAt);
        assert.equal((await jobDatabase().query('SELECT count(*) FROM "AvailabilityInterval" WHERE "serviceId"=$1 AND state=$2', [id, 'up'])).rows[0].count, '1');
      });

      await t.test('settings edits during network I/O fence observations without claiming a target failure', async () => {
        await reset();
        const dashboard = await createDashboard();
        const id = await createService(dashboard);
        let started!: () => void;
        let release!: () => void;
        const requestStarted = new Promise<void>((resolve) => { started = resolve; });
        targetHandler = async (_req, res) => { started(); await new Promise<void>((resolve) => { release = resolve; }); res.end(); };
        const execution = executeJob(await claimed(id), configuration);
        await requestStarted;
        await jobDatabase().query(`UPDATE "Dashboard" SET "monitoringEnabled"=false,
          "monitoringRevision"="monitoringRevision"+1 WHERE id=$1`, [dashboard]);
        release();
        await execution;
        assert.equal((await service(id)).checkedAt, null);
        assert.equal((await jobDatabase().query('SELECT count(*) FROM "AvailabilityInterval" WHERE "serviceId"=$1', [id])).rows[0].count, '0');
      });

      await t.test('owned transaction rolls back results and scheduling together on database errors', async () => {
        await reset();
        const id = await createService(await createDashboard());
        const job = await claimed(id);
        await assert.rejects(withOwnedJob(job, async (client) => {
          await client.query('UPDATE "Service" SET "checkedAt"=now() WHERE id=$1', [id]);
          throw new Error('Database result failed');
        }), /Database result failed/);
        assert.equal((await service(id)).checkedAt, null);
        assert.equal((await jobDatabase().query('SELECT status FROM "ServiceCheckJob" WHERE id=$1', [job.id])).rows[0].status, 'running');
        await releaseJob(job);
      });

      await t.test('maintenance only reconciles missing history, expired observations and settings transitions', async () => {
        await reset();
        const dashboard = await createDashboard();
        const id = await createService(dashboard);
        assert.equal(await reconcileHistories(), 1);
        assert.equal(await reconcileHistories(), 0);
        await executeJob(await claimed(id), configuration);
        assert.equal(await reconcileHistories(), 0);
        const observed = new Date(Date.now()-240_000);
        await jobDatabase().query(`UPDATE "AvailabilityInterval" SET "startedAt"=$2::timestamptz-interval '1 second',
          "lastObservedAt"=$2 WHERE "serviceId"=$1 AND "endedAt" IS NULL`, [id,observed]);
        assert.equal(await reconcileHistories(), 1);
        const gap = (await jobDatabase().query(`SELECT * FROM "AvailabilityInterval"
          WHERE "serviceId"=$1 AND "endedAt" IS NULL`, [id])).rows[0];
        assert.equal(gap.state, 'unknown');
        assert.equal(gap.reason, 'monitoring_gap');
        assert.equal(gap.startedAt.getTime(), observed.getTime()+180_000);
        assert.equal(await reconcileHistories(), 0);
        await jobDatabase().query(`UPDATE "Dashboard" SET "monitoringEnabled"=false WHERE id=$1`, [dashboard]);
        assert.equal(await reconcileHistories(), 1);
        assert.equal(await reconcileHistories(), 0);
        assert.equal((await jobDatabase().query(`SELECT state FROM "AvailabilityInterval"
          WHERE "serviceId"=$1 AND "endedAt" IS NULL`, [id])).rows[0].state, 'paused');
      });

      await t.test('scheduling a thousand services remains bounded across repeated and concurrent sweeps', async () => {
        await reset();
        const dashboard = await createDashboard();
        await jobDatabase().query(`INSERT INTO "Service"("dashboardId",name,host,"httpPreview","createdAt","updatedAt")
          SELECT $1, 'Service '||n, '127.0.0.1', false, now(), now() FROM generate_series(1,1000) n`, [dashboard]);
        const counts = await Promise.all([scheduleDueServiceJobs(), scheduleDueServiceJobs(), scheduleDueServiceJobs()]);
        assert.equal(counts.reduce((a,b) => a+b,0), 1000);
        assert.equal(await scheduleDueServiceJobs(), 0);
        const jobs = await Promise.all(Array.from({length: 10},(_,n) => claimNextJob(`fixture-${n}`)));
        assert.equal(new Set(jobs.map((job) => job?.id)).size, 10);
        assert.equal((await jobDatabase().query('SELECT count(*) FROM "ServiceCheckJob"')).rows[0].count, '1000');
      });

      await t.test('worker rejects schema drift without applying or repairing migrations', async () => {
        await reset();
        await jobDatabase().query('ALTER TABLE "Service" ADD COLUMN worker_drift_test text');
        try {
          await assert.rejects(waitForDatabase(new AbortController().signal, 5, 30, databaseUrl), /schema|catalog|drift/i);
          assert.equal((await jobDatabase().query(`SELECT count(*) FROM information_schema.columns
            WHERE table_schema='public' AND table_name='Service' AND column_name='worker_drift_test'`)).rows[0].count, '1');
        } finally {
          await jobDatabase().query('ALTER TABLE "Service" DROP COLUMN worker_drift_test');
        }
      });

      await t.test('three availability consumers monitor continuously with reusable jobs and independent screenshot capacity', async () => {
        await reset();
        const dashboard = await createDashboard();
        for (let index = 0; index < 5; index++) await createService(dashboard, `Service ${index}`);
        await jobDatabase().query(`UPDATE "Service" SET "httpPreview"=true WHERE "dashboardId"=$1`, [dashboard]);
        await jobDatabase().query(`UPDATE "Dashboard" SET "screenshotDemandUntil"=now()+interval '90 seconds' WHERE id=$1`, [dashboard]);
        screenshotDelayMs = 2000;
        await enqueueDashboardChecks(dashboard);
        let active = 0;
        let maximum = 0;
        targetHandler = async (_req, res) => {
          active++;
          maximum = Math.max(maximum, active);
          await delay(120);
          active--;
          res.end();
        };
        const original = { ...process.env };
        process.env.STAKEOUT_SERVER_DATABASE_URL = databaseUrl;
        delete process.env.STAKEOUT_SERVER_WORKER_CONCURRENCY;
        delete process.env.STAKEOUT_SERVER_SCREENSHOT_WORKER_CONCURRENCY;
        process.env.STAKEOUT_SERVER_CHROME_URL = configuration.chromeUrl;
        process.env.STAKEOUT_SERVER_CHROME_TOKEN = configuration.chromeToken;
        process.env.STAKEOUT_SERVER_WORKER_POLL_INTERVAL_MS = '20';
        const stop = new AbortController();
        try {
          await waitForDatabase(stop.signal, 20);
          const worker = runWorker(stop.signal);
          await until(async () => (await jobDatabase().query(`SELECT count(*) FROM "Service" WHERE "checkedAt" IS NOT NULL`)).rows[0].count === '5');
          stop.abort();
          await worker;
          assert.equal(maximum, 3);
          assert.equal(screenshotCalls, 1);
          configureJobDatabase(databaseUrl);
          assert.equal((await jobDatabase().query('SELECT count(*) FROM "ServiceCheckJob"')).rows[0].count, '10');
          assert.equal((await jobDatabase().query('SELECT count(*) FROM "Service" WHERE "screenshotCheckedAt" IS NOT NULL')).rows[0].count, '0');
        } finally {
          stop.abort();
          for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
          Object.assign(process.env, original);
        }
      });
    } finally {
      await target.close();
      await browserless.close();
      await closeJobDatabase();
    }
  });
});
