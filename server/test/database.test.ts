import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Client } from 'pg';
import { withPostgres } from './postgres.ts';
import { bootstrapDatabase, assertDatabaseReady, DatabaseNotReadyError } from '../src/bootstrap.ts';
import { readCatalog, catalogDifference } from '../src/db/catalog.ts';
import { BASELINE, BOOTSTRAP_LOCK, LAST_RAILS_VERSION, SERVER_ROOT } from '../src/db/migrate.ts';
import { createPrisma } from '../src/db/prisma.ts';
import { readConfig } from '../src/config.ts';

const run = promisify(execFile);
const names = [BASELINE, '20261019000100_retire_rails', '20261019000200_service_check_jobs', '20261019000300_screenshot_previews', '20261019000400_users_and_prisma_names', '20261019000500_availability_history', '20261019000600_requested_availability_checks'];
const migrationSql = (name: string) => readFile(join(SERVER_ROOT, 'prisma/migrations', name, 'migration.sql'), 'utf8');
async function clientFor<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url, options: '-c timezone=UTC' });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}
async function legacy(client: Client): Promise<void> {
  await client.query(await migrationSql(BASELINE));
  await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [LAST_RAILS_VERSION]);
  await client.query(`INSERT INTO ar_internal_metadata(key,value,created_at,updated_at)
    VALUES('environment','production',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
}
async function resolve(url: string, name: string): Promise<void> {
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve('prisma/package.json')), 'build/index.js');
  await run(process.execPath, [cli, 'migrate', 'resolve', '--applied', name, '--config', join(SERVER_ROOT, 'prisma.config.ts')], {
    cwd: SERVER_ROOT, env: { ...process.env, STAKEOUT_SERVER_DATABASE_URL: url },
  });
}
async function domainSnapshot(client: Client, renamed = false): Promise<unknown> {
  const dashboards = renamed ? '"Dashboard"' : 'dashboards';
  const services = renamed ? '"Service"' : 'services';
  const snapshot = (await client.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM ${dashboards} d) AS dashboards,
    (SELECT jsonb_agg(to_jsonb(s) - 'http_screenshot_hash' - 'http_screenshot_preview' - 'httpScreenshotHash' - 'httpScreenshotPreview' ORDER BY id) FROM ${services} s) AS services`)).rows[0];
  // Compare logical values across the physical column renames, including microseconds and bytes.
  const added = new Set(['monitoring_enabled','check_interval_seconds','screenshots_enabled','screenshot_interval_seconds',
    'screenshot_demand_until','monitoring_revision','hourly_retention_days','daily_retention_days','availability_retention_days',
    'history_started_at','config_revision','screenshot_checked_at','availability_pruned_before','availability_check_requested_at']);
  const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
      .map(([key, entry]) => [key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`), normalize(entry)])
      .filter(([key]) => !added.has(String(key)))) : value;
  return normalize(snapshot);
}
async function seedPreservationCases(client: Client): Promise<void> {
  await client.query(`INSERT INTO dashboards(id,name,created_at,updated_at) VALUES
    ('10000000-0000-4000-8000-000000000001','Original','2026-01-02 03:04:05.123456','2026-01-02 03:04:05.654321'),
    ('10000000-0000-4000-8000-000000000002',NULL,'2026-01-02 03:04:05.123456','2026-01-02 03:04:05.654321');
    INSERT INTO services(id,dashboard_id,name,host,port,http,https,http_preview,http_screenshot,checked_at,created_at,updated_at)
    VALUES('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Original','localhost',8081,
    true,false,true,decode('89504e470d0a1a0a0000ff','hex'),'2026-01-02 03:04:05.987654','2026-01-02 03:04:05.123456','2026-01-02 03:04:05.654321'),
    ('20000000-0000-4000-8000-000000000002',NULL,'Nullable legacy row','localhost',0,NULL,NULL,NULL,NULL,NULL,
    '2026-01-02 03:04:05.123456','2026-01-02 03:04:05.654321'),
    ('20000000-0000-4000-8000-000000000003',NULL,'Recently checked','localhost',0,false,false,false,NULL,
    CURRENT_TIMESTAMP AT TIME ZONE 'UTC','2026-01-02 03:04:05.123456','2026-01-02 03:04:05.654321');`);
}

test('fresh, legacy and repeated concurrent startup converge without changing legacy rows', async () => {
  await withPostgres(async freshUrl => withPostgres(async legacyUrl => {
    let before: unknown;
    await clientFor(legacyUrl, async client => {
      await legacy(client);
      await seedPreservationCases(client);
      before = await domainSnapshot(client);
      const expected = JSON.parse(await readFile(join(SERVER_ROOT, 'prisma/catalogs', `${BASELINE}.json`), 'utf8'));
      assert.equal(catalogDifference(await readCatalog(client), expected), undefined);
    });
    await Promise.all([bootstrapDatabase(freshUrl), bootstrapDatabase(freshUrl), bootstrapDatabase(legacyUrl)]);
    await clientFor(legacyUrl, async client => {
      assert.equal((await client.query("SELECT count(*)::int AS count FROM \"ServiceCheckJob\" WHERE status='pending'")).rows[0].count, 2);
      await client.query("UPDATE \"ServiceCheckJob\" SET status='completed',\"completedAt\"=CURRENT_TIMESTAMP");
    });
    await bootstrapDatabase(legacyUrl);
    await assertDatabaseReady(freshUrl);
    await assertDatabaseReady(legacyUrl);
    const freshCatalog = await clientFor(freshUrl, readCatalog);
    await clientFor(legacyUrl, async client => {
      assert.deepEqual(await domainSnapshot(client, true), before);
      const image = (await client.query(`SELECT "httpScreenshot", "httpScreenshotHash", "httpScreenshotPreview"
        FROM "Service" WHERE id='20000000-0000-4000-8000-000000000001'`)).rows[0];
      assert.equal(image.httpScreenshotHash, createHash('sha256').update(image.httpScreenshot).digest('hex'));
      assert.equal(image.httpScreenshotPreview, null);
      const policy = (await client.query('SELECT * FROM "Dashboard" ORDER BY id LIMIT 1')).rows[0];
      assert.equal(policy.monitoringEnabled,true);
      assert.equal(policy.checkIntervalSeconds,60);
      assert.equal(policy.hourlyRetentionDays,14);
      assert.equal(policy.dailyRetentionDays,null);
      assert.equal(policy.availabilityRetentionDays,null);
      assert.ok(policy.historyStartedAt > new Date('2026-01-02T03:04:05Z'));
      assert.equal((await client.query('SELECT count(*)::integer n FROM "AvailabilityInterval"')).rows[0].n,0,
        'legacy checks are not extrapolated into historical availability');
      assert.deepEqual(await readCatalog(client), freshCatalog);
      assert.equal((await client.query('SELECT count(*)::int AS count FROM "ServiceCheckJob"')).rows[0].count, 2);
      assert.equal((await client.query("SELECT count(*)::int AS count FROM \"ServiceCheckJob\" WHERE status='pending'")).rows[0].count, 0);
      assert.equal((await client.query(`SELECT count(*)::int AS count FROM information_schema.tables
        WHERE table_schema='public' AND (table_name LIKE 'solid_queue_%' OR table_name IN ('schema_migrations','ar_internal_metadata'))`)).rows[0].count, 0);
      const ledger = (await client.query('SELECT migration_name,checksum FROM _prisma_migrations ORDER BY migration_name')).rows;
      assert.deepEqual(ledger.map(row => row.migration_name), names);
      for (const row of ledger) assert.equal(row.checksum, createHash('sha256').update(await migrationSql(row.migration_name)).digest('hex'));
    });
    const prisma = createPrisma(legacyUrl);
    try {
      assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: '20000000-0000-4000-8000-000000000001' } })).port, 8081);
      assert.equal((await prisma.dashboard.findUniqueOrThrow({ where: { id: '10000000-0000-4000-8000-000000000002' } })).name, null);
    } finally { await prisma.$disconnect(); }
  }));
});

test('renaming preserves existing screenshot variants and in-flight queue leases', async () => {
  await withPostgres(async url => {
    await clientFor(url, async client => {
      await legacy(client);
      for (const name of names.slice(1, 4)) await client.query(await migrationSql(name));
      await seedPreservationCases(client);
      await client.query(`UPDATE services SET http_screenshot_hash=repeat('a',64),http_screenshot_preview=decode('0011ff','hex')
        WHERE id='20000000-0000-4000-8000-000000000001'`);
      await client.query(`INSERT INTO service_check_jobs(service_id,status,locked_by,lease_expires_at,attempts,max_attempts,last_error)
        VALUES('20000000-0000-4000-8000-000000000001','running','original-claim',CURRENT_TIMESTAMP+INTERVAL '1 hour',2,5,'retained diagnostic')`);
    });
    for (const name of names.slice(0, 4)) await resolve(url, name);
    const snapshot = async (renamed: boolean) => clientFor(url, async client => {
      const rows = await client.query(`SELECT
        (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM ${renamed ? '"Service"' : 'services'} s) AS services,
        (SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM ${renamed ? '"ServiceCheckJob"' : 'service_check_jobs'} j) AS jobs`);
      const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize)
        : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`), normalize(entry)])) : value;
      return normalize(rows.rows);
    });
    const before = await snapshot(false);
    // Verify the rename itself still preserves every screenshot byte and lease.
    await clientFor(url, async client => { await client.query(await migrationSql(names[4]!)); });
    assert.deepEqual(await snapshot(true), before);
    await resolve(url,names[4]!);
    // The next migration deliberately replaces transient claims with reusable tasks.
    await bootstrapDatabase(url);
    await clientFor(url, async client => {
      const jobs = (await client.query('SELECT kind,status,"lockedBy",attempts FROM "ServiceCheckJob" ORDER BY kind')).rows;
      assert.deepEqual(jobs,[{kind:'availability',status:'pending',lockedBy:null,attempts:0},
        {kind:'screenshot',status:'pending',lockedBy:null,attempts:0}]);
      const image=(await client.query(`SELECT "httpScreenshotHash","httpScreenshotPreview" FROM "Service"
        WHERE id='20000000-0000-4000-8000-000000000001'`)).rows[0];
      assert.equal(image.httpScreenshotHash,'a'.repeat(64));
      assert.equal(image.httpScreenshotPreview.toString('hex'),'0011ff');
    });
    await assertDatabaseReady(url);
  });
});

test('startup resumes after baseline resolution or a completed intermediate migration', async () => {
  for (const prefixLength of [1, 2, 3, 4, 5, 6]) await withPostgres(async url => {
    await clientFor(url, legacy);
    await resolve(url, BASELINE);
    for (const name of names.slice(1, prefixLength)) {
      await clientFor(url, async client => { await client.query(await migrationSql(name)); });
      await resolve(url, name);
    }
    await assert.rejects(assertDatabaseReady(url), DatabaseNotReadyError);
    await bootstrapDatabase(url);
    await assertDatabaseReady(url);
  });
});

test('operator recovery accepts obsolete rolled-back checksums while validating active history', async () => {
  await withPostgres(async url => {
    await bootstrapDatabase(url);
    await clientFor(url, async client => {
      // A failed original script was rolled back and corrected before the
      // successful current script. Prisma preserves both attempts in its ledger.
      await client.query(`INSERT INTO _prisma_migrations(id,checksum,migration_name,started_at,rolled_back_at,logs)
        VALUES('10000000-0000-4000-8000-000000000001',repeat('0',64),'20261019000200_service_check_jobs',
          CURRENT_TIMESTAMP-INTERVAL '2 minutes',CURRENT_TIMESTAMP-INTERVAL '1 minute','Original SQL failed before operator repair')`);
    });
    await bootstrapDatabase(url);
    await assertDatabaseReady(url);
    await clientFor(url, async client => {
      assert.equal((await client.query("SELECT checksum FROM _prisma_migrations WHERE id='10000000-0000-4000-8000-000000000001'")).rows[0].checksum, '0'.repeat(64));
      await client.query("UPDATE _prisma_migrations SET checksum=repeat('1',64) WHERE migration_name='20261019000200_service_check_jobs' AND rolled_back_at IS NULL");
    });
    await assert.rejects(bootstrapDatabase(url), /history diverges/);
    await assert.rejects(assertDatabaseReady(url), /history diverges/);
  });
});

test('unknown and drifted legacy schemas are rejected before any Prisma history is written', async () => {
  const variants = [
    'CREATE TABLE unexpected(id integer)',
    'ALTER TABLE services ADD COLUMN surprise text',
    'DROP INDEX index_services_on_dashboard_id_and_name',
    "CREATE VIEW unexpected AS SELECT id FROM services",
    "CREATE DOMAIN unexpected AS text CHECK (VALUE <> '')",
    "UPDATE schema_migrations SET version='20260204210000'",
    "INSERT INTO schema_migrations(version) VALUES('29990101000000')",
  ];
  for (const sql of variants) await withPostgres(async url => clientFor(url, async client => {
    await legacy(client);
    await client.query(sql);
    const before = await readCatalog(client);
    await assert.rejects(bootstrapDatabase(url), /Startup refused|does not match/);
    assert.deepEqual(await readCatalog(client), before);
    assert.equal((await client.query("SELECT to_regclass('public._prisma_migrations') AS name")).rows[0].name, null);
  }));
});

test('managed checksum changes, failed migrations, newer histories and schema drift refuse startup', async () => {
  const variants = [
    "UPDATE _prisma_migrations SET checksum=repeat('0',64) WHERE migration_name='0_legacy_baseline'",
    "UPDATE _prisma_migrations SET finished_at=NULL, logs='simulated interruption' WHERE migration_name='20261019000200_service_check_jobs'",
    "UPDATE _prisma_migrations SET migration_name='29990101000000_future' WHERE migration_name='20261019000200_service_check_jobs'",
    `INSERT INTO _prisma_migrations(id,checksum,migration_name,started_at,rolled_back_at)
      VALUES('10000000-0000-4000-8000-000000000001',repeat('0',64),'29990101000000_unknown_rolled_back',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    'ALTER TABLE "Service" ALTER COLUMN http SET NOT NULL',
    'CREATE UNIQUE INDEX unexpected ON "Dashboard"("createdAt")',
  ];
  for (const sql of variants) await withPostgres(async url => {
    await bootstrapDatabase(url);
    await clientFor(url, async client => {
      await client.query(sql);
      const before = await readCatalog(client);
      const ledger = (await client.query('SELECT * FROM _prisma_migrations ORDER BY migration_name')).rows;
      await assert.rejects(bootstrapDatabase(url), /refused|repair or restore/i);
      await assert.rejects(assertDatabaseReady(url), error => !(error instanceof DatabaseNotReadyError));
      assert.deepEqual(await readCatalog(client), before);
      assert.deepEqual((await client.query('SELECT * FROM _prisma_migrations ORDER BY migration_name')).rows, ledger);
    });
  });
});

test('outer bootstrap lock bounds startup and read-only worker readiness waits for the API', async () => {
  await withPostgres(async url => clientFor(url, async client => {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [BOOTSTRAP_LOCK]);
    await assert.rejects(bootstrapDatabase(url, { lockTimeoutMs: 100 }), /Timed out waiting/);
    await assert.rejects(assertDatabaseReady(url), DatabaseNotReadyError);
    assert.equal((await client.query("SELECT to_regclass('public._prisma_migrations') AS name")).rows[0].name, null);
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [BOOTSTRAP_LOCK]);
    await bootstrapDatabase(url);
    await assertDatabaseReady(url);
  }));
});

test('configuration preserves deployment environment names and validates worker limits lazily', () => {
  assert.throws(() => readConfig({}), /STAKEOUT_SERVER_DATABASE_URL/);
  const config = readConfig({ STAKEOUT_SERVER_DATABASE_URL: 'postgresql://unused/unused', STAKEOUT_SERVER_BOOTSTRAP_USERNAME: 'admin', STAKEOUT_SERVER_BOOTSTRAP_PASSWORD: 'test-password-123' });
  assert.equal(config.port, 3000);
  assert.equal(config.bootstrapUsername, 'admin');
  assert.equal(config.trustProxy, false);
  assert.equal(config.workerConcurrency, 3);
  assert.throws(() => readConfig({ STAKEOUT_SERVER_DATABASE_URL: config.databaseUrl, STAKEOUT_SERVER_WORKER_LEASE_MS: '100' }), /exceed/);
});
