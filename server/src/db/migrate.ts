import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { catalogDifference, readCatalog } from './catalog.ts';
import type { Catalog } from './catalog.ts';

export const SERVER_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const BASELINE = '0_legacy_baseline';
export const LAST_RAILS_VERSION = '20260204210100';
// Separate from Prisma's own lock; serialize the complete adoption workflow.
export const BOOTSTRAP_LOCK = '684561113020261019';

export interface BootstrapOptions {
  lockTimeoutMs?: number;
  commandTimeoutMs?: number;
}

export class DatabaseNotReadyError extends Error {
  readonly code = 'STAKEOUT_DATABASE_NOT_READY';
}

interface Migration {
  name: string;
  checksum: string;
  catalog: Catalog;
}

interface MigrationRecord {
  migration_name: string;
  checksum: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}

async function migrations(): Promise<Migration[]> {
  const base = join(SERVER_ROOT, 'prisma/migrations');
  const names = (await readdir(base, { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  return Promise.all(names.map(async name => ({
    name,
    checksum: createHash('sha256').update(await readFile(join(base, name, 'migration.sql'))).digest('hex'),
    catalog: JSON.parse(await readFile(join(SERVER_ROOT, 'prisma/catalogs', `${name}.json`), 'utf8')) as Catalog,
  })));
}

function isEmptyCatalog(catalog: Catalog): boolean {
  return Object.entries(catalog).every(([name, rows]) => name === 'extensions'
    ? rows.every(row => JSON.stringify(row) === JSON.stringify({ name: 'uuid-ossp', schema: 'public' }))
    : rows.length === 0);
}

function assertCatalog(actual: Catalog, expected: Catalog, state: string): void {
  const difference = catalogDifference(actual, expected);
  if (difference) throw new Error(`Database schema does not match ${state}: ${difference}. Startup refused; no automatic repair is performed.`);
}

async function checkRailsVersion(client: Client): Promise<void> {
  const rows = (await client.query<{ version: string }>('SELECT version FROM public.schema_migrations')).rows;
  if (!rows.some(row => row.version === LAST_RAILS_VERSION) ||
    rows.some(row => !/^\d+$/.test(row.version) || BigInt(row.version) > BigInt(LAST_RAILS_VERSION))) {
    throw new Error(`Only the latest Rails schema (${LAST_RAILS_VERSION}) can be adopted. Startup refused.`);
  }
}

async function appliedPrefix(client: Client, available: Migration[]): Promise<Migration[]> {
  const exists = (await client.query("SELECT to_regclass('public._prisma_migrations') AS name")).rows[0].name;
  if (!exists) return [];
  const rows = (await client.query<MigrationRecord>(`SELECT migration_name,checksum,finished_at,rolled_back_at
    FROM public._prisma_migrations ORDER BY migration_name,started_at`)).rows;
  const active = rows.filter(row => !row.rolled_back_at);
  if (active.some(row => !row.finished_at)) {
    throw new Error('Database has an unfinished or failed Prisma migration. Operator repair or restore is required before startup.');
  }
  const byName = new Map(available.map(migration => [migration.name, migration]));
  for (const row of rows) {
    const known = byName.get(row.migration_name);
    if (!known || known.checksum !== row.checksum) {
      throw new Error(`Database migration history diverges from this image at ${row.migration_name}. Startup refused.`);
    }
  }
  const prefix = available.slice(0, active.length);
  if (active.some((row, i) => row.migration_name !== prefix[i]?.name)) {
    throw new Error('Database migration history is not a valid applied prefix for this image. Startup refused.');
  }
  return prefix;
}

async function runPrisma(databaseUrl: string, args: string[], timeoutMs: number, assertLock: () => void, signal: AbortSignal): Promise<void> {
  assertLock();
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve('prisma/package.json')), 'build/index.js');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args, '--config', join(SERVER_ROOT, 'prisma.config.ts')], {
      cwd: SERVER_ROOT,
      env: { ...process.env, STAKEOUT_SERVER_DATABASE_URL: databaseUrl, DATABASE_URL: databaseUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    });
    let output = '';
    const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-12_000); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stopChild = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 2000);
    };
    const timer = setTimeout(() => { timedOut = true; stopChild(); }, timeoutMs);
    const interrupt = () => { stopChild(); };
    process.once('SIGTERM', interrupt);
    process.once('SIGINT', interrupt);
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      process.off('SIGTERM', interrupt);
      process.off('SIGINT', interrupt);
      try { assertLock(); } catch (error) { reject(error); return; }
      if (code === 0 && !timedOut) resolve();
      else reject(new Error(`Prisma ${args.join(' ')} ${timedOut ? 'timed out' : `failed (${code})`}. ${output.trim()}`));
    });
  });
  assertLock();
}

/** Validate, adopt if necessary, and migrate before any API or worker starts. */
export async function bootstrapDatabase(databaseUrl: string, options: BootstrapOptions = {}): Promise<void> {
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || (url.searchParams.get('schema') ?? 'public') !== 'public') {
    throw new Error('Stakeout migrations require a PostgreSQL URL using the public schema');
  }
  const available = await migrations();
  if (available[0]?.name !== BASELINE) throw new Error('Missing legacy baseline migration');
  const client = new Client({ connectionString: databaseUrl, options: '-c timezone=UTC', connectionTimeoutMillis: 10_000 });
  let lockFailure: Error | undefined;
  let locked = false;
  const abort = new AbortController();
  client.on('error', error => { lockFailure = error; abort.abort(error); });
  const assertLock = () => { if (lockFailure) throw new Error(`Bootstrap lock connection was lost: ${lockFailure.message}`); };
  await client.connect();
  try {
    const deadline = Date.now() + (options.lockTimeoutMs ?? 120_000);
    while (!locked) {
      locked = (await client.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [BOOTSTRAP_LOCK])).rows[0].locked;
      if (!locked) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for another Stakeout database bootstrap');
        await delay(Math.min(100, Math.max(1, deadline - Date.now())));
      }
    }
    assertLock();
    let prefix = await appliedPrefix(client, available);
    const catalog = await readCatalog(client);
    if (prefix.length) {
      assertCatalog(catalog, prefix.at(-1)!.catalog, prefix.at(-1)!.name);
    } else if (!isEmptyCatalog(catalog)) {
      assertCatalog(catalog, available[0].catalog, `latest Rails schema ${LAST_RAILS_VERSION}`);
      await checkRailsVersion(client);
      await runPrisma(databaseUrl, ['migrate', 'resolve', '--applied', BASELINE], options.commandTimeoutMs ?? 120_000, assertLock, abort.signal);
      prefix = await appliedPrefix(client, available);
      if (prefix.length !== 1) throw new Error('Prisma baseline was not recorded as expected');
    }
    await runPrisma(databaseUrl, ['migrate', 'deploy'], options.commandTimeoutMs ?? 120_000, assertLock, abort.signal);
    prefix = await appliedPrefix(client, available);
    if (prefix.length !== available.length) throw new Error('Database still has pending migrations after deployment');
    assertCatalog(await readCatalog(client), available.at(-1)!.catalog, 'current Stakeout schema');
  } finally {
    if (locked && !lockFailure) await client.query('SELECT pg_advisory_unlock($1::bigint)', [BOOTSTRAP_LOCK]).catch(() => {});
    await client.end().catch(() => {});
  }
}

/** Worker readiness checks never apply migrations or repair database history. */
export async function assertDatabaseReady(databaseUrl: string): Promise<void> {
  const available = await migrations();
  const client = new Client({ connectionString: databaseUrl, options: '-c timezone=UTC', connectionTimeoutMillis: 3000 });
  let locked = false;
  await client.connect();
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [BOOTSTRAP_LOCK])).rows[0].locked;
    if (!locked) throw new DatabaseNotReadyError('The API is migrating the database');
    const prefix = await appliedPrefix(client, available);
    const catalog = await readCatalog(client);
    if (!prefix.length) {
      if (!isEmptyCatalog(catalog)) {
        assertCatalog(catalog, available[0].catalog, 'latest Rails schema');
        await checkRailsVersion(client);
      }
      throw new DatabaseNotReadyError('The API has not adopted the database yet');
    }
    assertCatalog(catalog, prefix.at(-1)!.catalog, prefix.at(-1)!.name);
    if (prefix.length !== available.length) throw new DatabaseNotReadyError('The API has pending database migrations');
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1::bigint)', [BOOTSTRAP_LOCK]).catch(() => {});
    await client.end().catch(() => {});
  }
}
