import assert from 'node:assert/strict';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { once } from 'node:events';
import { test } from 'node:test';
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
  pruneFinishedJobs, recoverExpiredJobs, releaseJob, withOwnedJob,
} from '../src/jobs/queue.ts';
import { runWorker, waitForDatabase } from '../src/worker.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l8sAAAAASUVORK5CYII=', 'base64');
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
  assert.equal(serviceUrl({ host: 'example.com', port: 8123, http_path: '/ready?q=1' }, false).href, 'http://example.com:8123/ready?q=1');
  assert.equal(serviceUrl({ host: 'example.com', port: 8443, http_path: '' }, true).href, 'https://example.com:8443/');
  assert.equal(serviceUrl({ host: '::1', port: 8123, http_path: 'status' }, false).href, 'http://[::1]:8123/status');
  assert.equal(serviceUrl({ host: 'example.com', port: 0, http_path: '/' }, true).href, 'https://example.com/');
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
    const browserless = await listen(async (req, res) => {
      screenshotPath = req.url;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      screenshotBody = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(screenshotStatus, { 'Content-Type': 'image/png' });
      res.end(screenshotResult);
    });
    const configuration = { chromeUrl: `${browserless.url}/chromium`, chromeToken: 'a&b' };
    const reset = async () => {
      await jobDatabase().query('DELETE FROM services');
      await jobDatabase().query('DELETE FROM dashboards');
      targetHandler = (_req, res) => res.end('OK');
      screenshotStatus = 200;
      screenshotResult = png;
    };
    const createDashboard = async () => {
      const result = await jobDatabase().query<{ id: string }>(
        `INSERT INTO dashboards(name, created_at, updated_at) VALUES ('Example', now(), '2020-01-01') RETURNING id`,
      );
      return result.rows[0]!.id;
    };
    const createService = async (dashboardId: string, name = 'Service') => {
      const result = await jobDatabase().query<{ id: string }>(
        `INSERT INTO services(dashboard_id, name, host, port, http_path, http_preview, created_at, updated_at)
         VALUES ($1, $2, '127.0.0.1', $3, '/health', false, now(), now()) RETURNING id`,
        [dashboardId, name, target.port],
      );
      return result.rows[0]!.id;
    };
    const claimed = async (serviceId: string, leaseMs = 90_000) => {
      assert.equal(await enqueueServiceCheck(serviceId), true);
      const job = await claimNextJob('test-worker', leaseMs);
      assert.ok(job);
      assert.equal(job.service_id, serviceId);
      return job;
    };
    const service = async (id: string) => (await jobDatabase().query('SELECT * FROM services WHERE id = $1', [id])).rows[0];
    try {
      await t.test('deduplicates concurrent enqueue and claims; lists enqueue all stale dashboard services', async () => {
        await reset();
        const dashboard = await createDashboard();
        const first = await createService(dashboard, 'First');
        const second = await createService(dashboard, 'Second');
        const fresh = await createService(dashboard, 'Fresh');
        await jobDatabase().query(`UPDATE services SET checked_at = now() - interval '59 seconds' WHERE id = $1`, [fresh]);
        const attempts = await Promise.all(Array.from({ length: 20 }, () => enqueueServiceCheck(first)));
        assert.equal(attempts.filter(Boolean).length, 1);
        assert.equal(await enqueueDashboardChecks(dashboard), 1);
        const jobs = await Promise.all([claimNextJob('one'), claimNextJob('two'), claimNextJob('three')]);
        assert.equal(jobs.filter(Boolean).length, 2);
        assert.deepEqual(new Set(jobs.filter(Boolean).map((job) => job!.service_id)), new Set([first, second]));
        assert.equal(await enqueueServiceCheck(first), false);
        await jobDatabase().query(`UPDATE services SET checked_at = now() - interval '2 minutes' WHERE id = $1`, [fresh]);
        assert.equal(await enqueueChecksOlderThanFiveMinutes(), 0);
        assert.equal(await enqueueServiceCheck(fresh), true);
      });

      await t.test('custom HTTP port, 302 availability without following redirects, PNG preview and dashboard touch', async () => {
        await reset();
        const dashboard = await createDashboard();
        const id = await createService(dashboard);
        await jobDatabase().query(`UPDATE services SET http_preview = true WHERE id = $1`, [id]);
        const paths: string[] = [];
        targetHandler = (req, res) => {
          paths.push(req.url ?? '');
          res.writeHead(302, { Location: '/never-follow' });
          res.end();
        };
        await executeJob(await claimed(id), configuration);
        const row = await service(id);
        assert.equal(row.http_path_last, true);
        assert.equal(row.https_path_last, false);
        assert.ok(row.checked_at);
        assert.deepEqual(row.http_screenshot, png);
        assert.deepEqual(paths, ['/health']);
        assert.equal(screenshotPath, '/chromium/screenshot?token=a%26b');
        assert.deepEqual(screenshotBody, JSON.parse(screenshotRequestBody(`${target.url}/health`)));
        const touched = await jobDatabase().query('SELECT updated_at FROM dashboards WHERE id = $1', [dashboard]);
        assert.ok(touched.rows[0].updated_at.getTime() > new Date('2020-01-01').getTime());
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
          await deletion.query('DELETE FROM services WHERE id=$1', [deleted]);
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
          await edit.query(`UPDATE services SET name='Edited' WHERE id=$1`, [edited]);
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
        await jobDatabase().query(`UPDATE services SET http_preview = true, http_screenshot = $2 WHERE id = $1`, [id, png]);
        targetHandler = (_req, res) => { res.writeHead(404); res.end('missing'); };
        screenshotResult = Buffer.from('not a PNG');
        await executeJob(await claimed(id), configuration);
        let row = await service(id);
        assert.equal(row.http_path_last, false);
        assert.equal(row.http_screenshot, null);
        assert.ok(row.checked_at);
        screenshotStatus = 500;
        screenshotResult = png;
        assert.equal(await fetchScreenshot('about:blank', configuration, AbortSignal.timeout(1000)), null);
        await jobDatabase().query(`UPDATE services SET checked_at = NULL, http = false, https = false, http_screenshot = $2 WHERE id = $1`, [id, png]);
        await executeJob(await claimed(id), configuration);
        row = await service(id);
        assert.equal(row.http_screenshot, null);
        assert.ok(row.checked_at);
        assert.equal(row.http_path_last, false);
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
          await jobDatabase().query(`UPDATE services SET port=$2, http=false, https=true, http_preview=true WHERE id=$1`, [id, address.port]);
          await executeJob(await claimed(id), configuration);
          const row = await service(id);
          assert.equal(row.https_path_last, true);
          assert.equal(row.http_path_last, false);
          assert.deepEqual(row.http_screenshot, png);
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
        await jobDatabase().query('UPDATE services SET checked_at = now() WHERE id = $1', [id]);
        let calls = 0;
        targetHandler = (_req, res) => { calls++; res.end(); };
        await executeJob(job, configuration);
        assert.equal(calls, 0);
        assert.equal((await jobDatabase().query('SELECT status FROM service_check_jobs WHERE id=$1', [job.id])).rows[0].status, 'completed');
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
        await jobDatabase().query(`UPDATE services SET name = 'Edited', checked_at = NULL, http_path_last = false,
          http_path = '/edited', updated_at = updated_at WHERE id = $1`, [id]);
        release();
        await execution;
        const edited = await service(id);
        assert.equal(edited.name, 'Edited');
        assert.equal(edited.checked_at, null);
        assert.equal(edited.http_path_last, false);
        assert.equal(await enqueueServiceCheck(id), true);
        await jobDatabase().query('DELETE FROM services WHERE id=$1', [id]);
        id = await createService(dashboard, 'Deleted');
        requestStarted = new Promise<void>((resolve) => { started = resolve; });
        execution = executeJob(await claimed(id), configuration);
        await requestStarted;
        await jobDatabase().query('DELETE FROM services WHERE id=$1', [id]);
        release();
        await execution;
        assert.equal(await service(id), undefined);
        assert.equal((await jobDatabase().query('SELECT count(*) FROM service_check_jobs')).rows[0].count, '0');
      });

      await t.test('expired leases recover once, reject old execution writes and exhaust retries', async () => {
        await reset();
        const id = await createService(await createDashboard());
        const old = await claimed(id);
        await jobDatabase().query(`UPDATE service_check_jobs SET lease_expires_at = now() - interval '1 second' WHERE id=$1`, [old.id]);
        assert.equal(await recoverExpiredJobs(), 1);
        const current = await claimNextJob('same-worker');
        assert.ok(current);
        assert.notEqual(current.locked_by, old.locked_by);
        assert.equal(current.attempts, 2);
        assert.equal(await heartbeatJob(old), false);
        await releaseJob(old);
        assert.equal(await checkService(old, configuration, AbortSignal.timeout(1000)), false);
        assert.equal((await service(id)).checked_at, null);
        await jobDatabase().query(`UPDATE service_check_jobs SET attempts=max_attempts,
          lease_expires_at=now()-interval '1 second' WHERE id=$1`, [current.id]);
        assert.equal(await recoverExpiredJobs(), 1);
        assert.equal((await jobDatabase().query('SELECT status FROM service_check_jobs WHERE id=$1', [old.id])).rows[0].status, 'failed');
        assert.equal(await claimNextJob('other'), null);
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
          await deletion.query('SELECT id FROM services WHERE id=$1 FOR UPDATE', [id]);
          const ownerPid = (await deletion.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          completion = withOwnedJob(job, async (client) => {
            ranAction = true;
            await client.query('UPDATE services SET checked_at=now() WHERE id=$1', [id]);
          });
          // Observe the actual lock wait instead of relying on timer scheduling.
          const deadline = Date.now() + 5000;
          while (true) {
            const waiting = await jobDatabase().query(`SELECT 1 FROM pg_stat_activity
              WHERE wait_event_type='Lock' AND query LIKE '%services%'
                AND $1::integer = ANY(pg_blocking_pids(pid))`, [ownerPid]);
            if (waiting.rowCount) break;
            assert.ok(Date.now() < deadline, 'Completion should be waiting on the service row');
          }
          // With the old job-first order this fails NOWAIT because completion
          // holds the job lock while waiting for the service held by deletion.
          await deletion.query('SELECT id FROM service_check_jobs WHERE id=$1 FOR UPDATE NOWAIT', [job.id]);
          await deletion.query('DELETE FROM services WHERE id=$1', [id]);
          await deletion.query('COMMIT');
          transactionOpen = false;
          assert.equal(await completion, false);
          assert.equal(ranAction, false);
          assert.equal((await jobDatabase().query('SELECT count(*) FROM service_check_jobs WHERE id=$1', [job.id])).rows[0].count, '0');
        } finally {
          if (transactionOpen) await deletion.query('ROLLBACK');
          deletion.release();
          if (completion) await completion.catch(() => {});
        }
      });

      await t.test('deadline retries and shutdown releases claimed work without writing a result', async () => {
        await reset();
        const id = await createService(await createDashboard());
        targetHandler = () => {};
        const first = await claimed(id);
        await executeJob(first, configuration, { timeoutMs: 40 });
        let row = (await jobDatabase().query('SELECT * FROM service_check_jobs WHERE id=$1', [first.id])).rows[0];
        assert.equal(row.status, 'pending');
        assert.equal(row.attempts, 1);
        assert.match(row.last_error, /deadline/);
        assert.equal((await service(id)).checked_at, null);
        await jobDatabase().query('UPDATE service_check_jobs SET available_at=now() WHERE id=$1', [first.id]);
        const second = await claimNextJob('shutdown');
        assert.ok(second);
        const stop = new AbortController();
        const execution = executeJob(second, configuration, { signal: stop.signal });
        await delay(20);
        stop.abort();
        await execution;
        row = (await jobDatabase().query('SELECT * FROM service_check_jobs WHERE id=$1', [first.id])).rows[0];
        assert.equal(row.status, 'pending');
        assert.equal(row.attempts, 1);
        await jobDatabase().query('UPDATE service_check_jobs SET available_at=now(), attempts=max_attempts-1 WHERE id=$1', [first.id]);
        const final = await claimNextJob('last');
        assert.ok(final);
        await executeJob(final, configuration, { timeoutMs: 25 });
        assert.equal((await jobDatabase().query('SELECT status FROM service_check_jobs WHERE id=$1', [first.id])).rows[0].status, 'failed');
      });

      await t.test('heartbeat keeps a slow check owned while another worker performs lease recovery', async () => {
        await reset();
        const id = await createService(await createDashboard());
        targetHandler = async (_req, res) => { await delay(650); res.end(); };
        const execution = executeJob(await claimed(id, 300), configuration, { leaseMs: 300 });
        await delay(420);
        assert.equal(await recoverExpiredJobs(), 0);
        await execution;
        assert.ok((await service(id)).checked_at);
      });

      await t.test('housekeeping prunes old terminal history and leaves fresh/active jobs alone', async () => {
        await reset();
        const id = await createService(await createDashboard());
        await jobDatabase().query(`INSERT INTO service_check_jobs(service_id,status,completed_at)
          VALUES ($1,'completed',now()-interval '8 days'), ($1,'failed',now()-interval '8 days'),
            ($1,'completed',now()), ($1,'pending',NULL)`, [id]);
        assert.equal(await pruneFinishedJobs(), 2);
        assert.equal((await jobDatabase().query('SELECT count(*) FROM service_check_jobs')).rows[0].count, '2');
      });

      await t.test('worker rejects schema drift without applying or repairing migrations', async () => {
        await reset();
        await jobDatabase().query('ALTER TABLE services ADD COLUMN worker_drift_test text');
        try {
          await assert.rejects(waitForDatabase(new AbortController().signal, 5, 30, databaseUrl), /schema|catalog|drift/i);
          assert.equal((await jobDatabase().query(`SELECT count(*) FROM information_schema.columns
            WHERE table_schema='public' AND table_name='services' AND column_name='worker_drift_test'`)).rows[0].count, '1');
        } finally {
          await jobDatabase().query('ALTER TABLE services DROP COLUMN worker_drift_test');
        }
      });

      await t.test('three worker consumers run concurrently, wait for schema and stop without adding periodic checks', async () => {
        await reset();
        const dashboard = await createDashboard();
        for (let index = 0; index < 5; index++) await createService(dashboard, `Service ${index}`);
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
        process.env.STAKEOUT_SERVER_WORKER_POLL_INTERVAL_MS = '20';
        const stop = new AbortController();
        try {
          await waitForDatabase(stop.signal, 20);
          const worker = runWorker(stop.signal);
          await until(async () => (await jobDatabase().query(`SELECT count(*) FROM service_check_jobs WHERE status='completed'`)).rows[0].count === '5');
          stop.abort();
          await worker;
          assert.equal(maximum, 3);
          configureJobDatabase(databaseUrl);
          assert.equal((await jobDatabase().query('SELECT count(*) FROM service_check_jobs')).rows[0].count, '5');
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
