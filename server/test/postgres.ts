import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';

const exec = promisify(execFile);

async function assertPostgres18(client: Client): Promise<void> {
  const version = Number((await client.query('SHOW server_version_num')).rows[0].server_version_num);
  if (version < 180000 || version >= 190000) throw new Error(`Tests require official PostgreSQL 18; got ${version}`);
}

async function isolatedDatabase<T>(baseUrl: string, fn: (url: string) => Promise<T>): Promise<T> {
  const admin = new Client({ connectionString: baseUrl, connectionTimeoutMillis: 3000 });
  const name = `stakeout_test_${randomUUID().replaceAll('-', '')}`;
  await admin.connect();
  let created = false;
  try {
    await assertPostgres18(admin);
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const url = new URL(baseUrl);
    url.pathname = `/${name}`;
    return await fn(url.toString());
  } finally {
    if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  }
}

/** Every callback gets an isolated PostgreSQL 18 database, never a local DB. */
export async function withPostgres<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const provided = process.env.STAKEOUT_TEST_DATABASE_URL;
  if (provided) return isolatedDatabase(provided, fn);
  const name = `codex-stakeout-test-${randomUUID()}`;
  const volume = `${name}-data`;
  await exec('docker', ['volume', 'create', volume]);
  try {
    await exec('docker', ['run', '--rm', '-d', '--name', name,
      '-e', 'POSTGRES_USER=stakeout', '-e', 'POSTGRES_PASSWORD=stakeout-test',
      '-e', 'POSTGRES_DB=postgres', '-p', '127.0.0.1::5432',
      '-v', `${volume}:/var/lib/postgresql`, 'postgres:18']);
    const { stdout } = await exec('docker', ['port', name, '5432/tcp']);
    const port = stdout.trim().split(':').at(-1);
    const url = `postgresql://stakeout:stakeout-test@127.0.0.1:${port}/postgres`;
    const deadline = Date.now() + 30_000;
    while (true) {
      const client = new Client({ connectionString: url, connectionTimeoutMillis: 1000 });
      try { await client.connect(); await assertPostgres18(client); await client.end(); break; }
      catch (error) { await client.end().catch(() => {}); if (Date.now() >= deadline) throw error; await delay(100); }
    }
    return await isolatedDatabase(url, fn);
  } finally {
    // --rm cleanup can complete after Docker returns from stop/run. Remove even
    // a partially started container, then wait for its volume reference to clear.
    await exec('docker', ['rm', '--force', name]).catch(() => {});
    for (let attempt = 0; attempt < 20; attempt++) {
      try { await exec('docker', ['volume', 'rm', volume]); break; }
      catch (error) { if (attempt === 19) throw error; await delay(100); }
    }
  }
}
