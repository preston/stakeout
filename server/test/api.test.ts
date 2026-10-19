// Author: Preston Lee

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { test } from 'node:test';
import { bootstrapUser } from '../src/auth/accounts.ts';
import type { SessionDto } from '@stakeout/core';
import { createApp } from '../src/app.ts';
import { createPrisma } from '../src/db/prisma.ts';
import { bootstrapDatabase } from '../src/bootstrap.ts';
import { withPostgres } from './postgres.ts';
import { rubyBase64 } from '../src/api/serialization.ts';
import { readCatalog } from '../src/db/catalog.ts';
import { BASELINE, LAST_RAILS_VERSION } from '../src/db/migrate.ts';

interface CapturedResponse {
  status: number;
  body: unknown;
  location: string | null;
  content_type: string | null;
}

const fixtures = (JSON.parse(await readFile(new URL('./fixtures/rails-responses.json', import.meta.url), 'utf8')) as {
  responses: Record<string, CapturedResponse>;
}).responses;
const DASHBOARD_ID = '11111111-1111-4111-8111-111111111111';
const SERVICE_ID = '22222222-2222-4222-8222-222222222222';
const DATE = new Date('2026-01-02T03:04:05.000Z');
const exec = promisify(execFile);

function normalize(value: unknown, ids: Record<string, string> = {}): unknown {
  if (Array.isArray(value)) return value.map(item => normalize(item, ids));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !['monitoring_enabled','check_interval_seconds','screenshots_enabled','screenshot_interval_seconds','hourly_retention_days','daily_retention_days','availability_retention_days'].includes(key)).map(([key, item]) => [key,
      ['created_at', 'updated_at', 'checked_at', 'datetime'].includes(key) && item !== null ? '<datetime>' : normalize(item, ids)]));
  }
  if (typeof value === 'string') {
    for (const [actual, expected] of Object.entries(ids)) value = (value as string).replaceAll(actual, expected);
  }
  return value;
}

async function close(server: Server): Promise<void> {
  server.closeIdleConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('manual checks, queue verification and seeds refuse unadopted databases without migrating', { timeout: 180_000 }, async () => {
  await withPostgres(async databaseUrl => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    const env = { ...process.env, STAKEOUT_SERVER_DATABASE_URL: databaseUrl };
    const commands = [
      ['src/cli.ts', 'check', '1'],
      ['src/cli.ts', 'check', '5'],
      ['src/cli.ts', 'verify', 'queue'],
      ['prisma/seed.ts'],
    ];
    const refuseWithoutMigration = async () => {
      const before = await readCatalog(client);
      for (const command of commands) {
        await assert.rejects(exec(process.execPath, command, { cwd, env }), /The API has not adopted the database yet/);
        assert.equal((await client.query("SELECT to_regclass('public._prisma_migrations') AS ledger")).rows[0].ledger, null);
        assert.deepEqual(await readCatalog(client), before);
      }
    };
    try {
      await refuseWithoutMigration();
      await client.query(await readFile(new URL(`../prisma/migrations/${BASELINE}/migration.sql`, import.meta.url), 'utf8'));
      await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [LAST_RAILS_VERSION]);
      await client.query(`INSERT INTO ar_internal_metadata(key,value,created_at,updated_at)
        VALUES('environment','production',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
      await client.query(`INSERT INTO dashboards(name,created_at,updated_at)
        VALUES('Untouched deployment',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
      const beforeRows = (await client.query(`SELECT
        (SELECT jsonb_agg(to_jsonb(d)) FROM dashboards d) AS dashboards,
        (SELECT jsonb_agg(to_jsonb(m)) FROM schema_migrations m) AS migrations,
        (SELECT jsonb_agg(to_jsonb(m)) FROM ar_internal_metadata m) AS metadata`)).rows;
      await refuseWithoutMigration();
      assert.deepEqual((await client.query(`SELECT
        (SELECT jsonb_agg(to_jsonb(d)) FROM dashboards d) AS dashboards,
        (SELECT jsonb_agg(to_jsonb(m)) FROM schema_migrations m) AS migrations,
        (SELECT jsonb_agg(to_jsonb(m)) FROM ar_internal_metadata m) AS metadata`)).rows, beforeRows);
    } finally {
      await client.end();
    }
  });
});

test('HTTP API preserves captured Rails responses and corrects supported defects', { timeout: 180_000 }, async t => {
  await withPostgres(async databaseUrl => {
    await bootstrapDatabase(databaseUrl);
    const prisma = createPrisma(databaseUrl);
    await bootstrapUser(prisma, { bootstrapUsername: 'admin', bootstrapPassword: 'sëcret:password' });
    const enqueued: string[] = [];
    const app = createApp({ prisma, config: { production: false, corsOrigin: 'http://localhost:4200', trustProxy: true },
      enqueueDashboardChecks: async id => { enqueued.push(id); return 0; } });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${origin}/auth/login`, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'sëcret:password' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const csrf = ((await login.json()) as SessionDto).csrfToken;
    const request = async (path: string, options: { method?: string; body?: unknown; authenticated?: boolean; headers?: Record<string, string>; raw?: string } = {}): Promise<CapturedResponse> => {
      const response = await fetch(`${origin}${path}`, {
        method: options.method ?? 'GET',
        headers: { Host: 'example.test', Accept: 'application/json',
          ...(options.authenticated ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}),
          ...(options.body !== undefined || options.raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...options.headers },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : options.raw !== undefined ? { body: options.raw } : {}),
      });
      const text = await response.text();
      return { status: response.status, body: text.length ? JSON.parse(text) as unknown : null,
        location: response.headers.get('location'), content_type: response.headers.get('content-type') };
    };
    const compare = (name: string, actual: CapturedResponse, ids: Record<string, string> = {}) => {
      // The live test server has an ephemeral listen address; Rails used example.test.
      assert.deepEqual(normalize(actual, { ...ids, [origin]: 'http://example.test' }), fixtures[name], name);
    };
    try {
      await t.test('JSON negotiation, credentialed CORS and rejected Basic authentication', async () => {
        assert.equal((await request('/dashboards', { headers: { Accept: '*/*' } })).status, 406);
        assert.equal((await request('/dashboards.json', { headers: { Accept: '*/*' } })).status, 200);
        assert.equal((await request('/status', { headers: { Accept: 'text/html' } })).status, 406);
        assert.equal((await request('/health', { headers: { Accept: '*/*' } })).status, 200);
        assert.equal((await request('/test', { method: 'POST' })).status, 401);
        assert.equal((await request('/dashboards', { method: 'POST', body: { dashboard: { name: 'Denied' } }, headers: { Authorization: 'Basic invalid' } })).status, 401);
        const preflight = await fetch(`${origin}/dashboards`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:4200',
          'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:4200');
        assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
        assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /authorization/);
      });

      await t.test('Rails format=json URLs preserve JSON negotiation and authentication', async () => {
        for (const path of ['/?format=json', '/dashboards?format=json', '/status?format=json']) {
          assert.equal((await request(path, { headers: { Accept: '*/*' } })).status, 200);
        }
        assert.equal((await request('/dashboards?format=xml', { headers: { Accept: '*/*' } })).status, 406);
        assert.equal((await request('/test?format=json', { method: 'POST', headers: { Accept: '*/*' } })).status, 401);
        assert.equal((await request('/test?format=json', { method: 'POST', authenticated: true, headers: { Accept: '*/*' } })).status, 404);
      });

      let dashboardId = '';
      let serviceId = '';
      const ids: Record<string, string> = {};
      await t.test('dashboard create, read, .json and proxy URLs match Rails captures', async () => {
        const created = await request('/dashboards', { method: 'POST', authenticated: true, body: { dashboard: { name: 'Example', ignored: 'value' } } });
        dashboardId = (created.body as { id: string }).id;
        ids[dashboardId] = DASHBOARD_ID;
        compare('dashboard_create', created, ids);
        compare('dashboard_index', await request('/dashboards'), ids);
        compare('dashboard_index', await request('/'), ids);
        compare('dashboard_show', await request(`/dashboards/${dashboardId}`), ids);
        compare('dashboard_show_json', await request(`/dashboards/${dashboardId}.json`, { headers: { Accept: '*/*' } }), ids);
        compare('dashboard_forwarded', await request(`/dashboards/${dashboardId}`, { headers: { 'X-Forwarded-Host': 'monitor.example.org', 'X-Forwarded-Proto': 'https' } }), ids);
        compare('dashboard_update', await request(`/dashboards/${dashboardId}`, { method: 'PATCH', authenticated: true, body: { dashboard: { name: 'Renamed' } } }), ids);
      });

      await t.test('service create, read, screenshot omission/encoding and update match Rails captures', async () => {
        const created = await request(`/dashboards/${dashboardId}/services`, { method: 'POST', authenticated: true,
          body: { service: { name: 'Site', host: 'example.org' } } });
        serviceId = (created.body as { id: string }).id;
        ids[serviceId] = SERVICE_ID;
        compare('service_create', created, ids);
        await prisma.service.update({ where: { id: serviceId }, data: { checkedAt: DATE,
          httpScreenshot: Buffer.from('iVBORw0KGgpmaXh0dXJl', 'base64') } });
        compare('service_show', await request(`/dashboards/${dashboardId}/services/${serviceId}`), ids);
        compare('service_index', await request(`/dashboards/${dashboardId}/services`), ids);
        compare('service_index_screenshots', await request(`/dashboards/${dashboardId}/services?screenshots=true`), ids);
        assert.deepEqual(enqueued, [dashboardId, dashboardId]);
        const before = await prisma.dashboard.findUniqueOrThrow({ where: { id: dashboardId } });
        compare('service_update', await request(`/dashboards/${dashboardId}/services/${serviceId}`, { method: 'PATCH', authenticated: true,
          body: { service: { name: 'Changed', host: 'new.example.org' } } }), ids);
        const updated = await prisma.service.findUniqueOrThrow({ where: { id: serviceId } });
        assert.equal(updated.checkedAt, null);
        assert.equal(updated.httpScreenshot, null);
        assert.ok((await prisma.dashboard.findUniqueOrThrow({ where: { id: dashboardId } })).updatedAt > before.updatedAt);
        assert.equal(rubyBase64(Buffer.alloc(90, 1)), `${Buffer.alloc(90, 1).toString('base64').match(/.{1,60}/g)?.join('\n')}\n`);
      });

      await t.test('sorting, full text prefix search and dashboard scoping', async () => {
        const other = await prisma.dashboard.create({ data: { name: 'Alpha Status', createdAt: DATE, updatedAt: DATE } });
        await prisma.service.create({ data: { dashboardId: dashboardId, name: 'Alpha Database', host: 'database.example.org', createdAt: DATE, updatedAt: DATE } });
        const sorted = await request(`/dashboards/${dashboardId}/services?sort=name&order=desc`);
        assert.deepEqual((sorted.body as { name: string }[]).map(service => service.name), ['Changed', 'Alpha Database']);
        const searched = await request(`/dashboards/${dashboardId}/services?text=alp%20data`);
        assert.deepEqual((searched.body as { name: string }[]).map(service => service.name), ['Alpha Database']);
        assert.equal(enqueued.at(-1), dashboardId);
        assert.equal((await request('/dashboards?text=alp')).status, 200);
        assert.deepEqual(((await request('/dashboards?text=alp')).body as { name: string }[]).map(dashboard => dashboard.name), ['Alpha Status']);
        assert.equal((await request(`/dashboards/${other.id}/services/${serviceId}`)).status, 404);
        assert.equal((await request(`/dashboards/${other.id}/services/${serviceId}`, { method: 'PUT', authenticated: true, body: { service: { name: 'Stolen' } } })).status, 404);
        await request(`/dashboards/${dashboardId}/services/${serviceId}`, { method: 'PUT', authenticated: true, body: { service: { dashboard_id: other.id } } });
        assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: serviceId } })).dashboardId, dashboardId);
        assert.equal((await request(`/dashboards/${dashboardId}/check`)).status, 404);
        assert.equal((await request('/dashboards/not-a-uuid')).status, 404);
      });

      await t.test('validation and explicit error repairs remain JSON', async () => {
        compare('invalid_dashboard', await request('/dashboards', { method: 'POST', authenticated: true, body: { dashboard: { name: '' } } }));
        assert.equal((await request('/dashboards', { method: 'POST', authenticated: true, body: {} })).status, 400);
        assert.equal((await request('/dashboards', { method: 'POST', authenticated: true, raw: '{invalid' })).status, 400);
        const invalid = await request(`/dashboards/${dashboardId}/services`, { method: 'POST', authenticated: true, body: { service: { name: '', host: '' } } });
        assert.equal(invalid.status, 422);
        assert.deepEqual(invalid.body, { name: ["can't be blank"], host: ["can't be blank"] });
        const duplicate = await request('/dashboards', { method: 'POST', authenticated: true, body: { dashboard: { name: 'Renamed' } } });
        assert.equal(duplicate.status, 422);
        assert.deepEqual(duplicate.body, { name: ['has already been taken'] });
        assert.equal((await request(`/dashboards/${dashboardId}/services/${serviceId}`, { method: 'PATCH', authenticated: true, body: { service: { port: 65536 } } })).status, 422);
      });

      await t.test('public status retains the expected health shape', async () => {
        const status = await request('/status');
        compare('status', status);
        const value = status.body as { server: { datetime: string }; database: { datetime: string } };
        assert.ok(Number.isFinite(Date.parse(value.server.datetime)));
        assert.ok(Number.isFinite(Date.parse(value.database.datetime)));
      });

      await t.test('dependent deletes, response bodies and dashboard touching', async () => {
        const before = await prisma.dashboard.findUniqueOrThrow({ where: { id: dashboardId } });
        compare('service_delete', await request(`/dashboards/${dashboardId}/services/${serviceId}`, { method: 'DELETE', authenticated: true }));
        assert.ok((await prisma.dashboard.findUniqueOrThrow({ where: { id: dashboardId } })).updatedAt > before.updatedAt);
        compare('dashboard_delete', await request(`/dashboards/${dashboardId}`, { method: 'DELETE', authenticated: true }));
        assert.equal(await prisma.service.count({ where: { dashboardId: dashboardId } }), 0);
        assert.equal((await request(`/dashboards/${dashboardId}`)).status, 404);
      });

      await t.test('explicit seed is idempotent and CLI checks enqueue without starting a scheduler', async () => {
        const cwd = fileURLToPath(new URL('..', import.meta.url));
        const env = { ...process.env, STAKEOUT_SERVER_DATABASE_URL: databaseUrl };
        await exec(process.execPath, ['prisma/seed.ts'], { cwd, env });
        assert.equal(await prisma.service.count(), 13);
        const example = await prisma.dashboard.findUniqueOrThrow({ where: { name: 'Example' } });
        const google = await prisma.service.findUniqueOrThrow({ where: { dashboardId_name: { dashboardId: example.id, name: 'Google' } } });
        await prisma.service.update({ where: { id: google.id }, data: { host: 'custom.example.org' } });
        await exec(process.execPath, ['prisma/seed.ts'], { cwd, env });
        assert.equal(await prisma.service.count(), 13);
        assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: google.id } })).host, 'custom.example.org');
        assert.equal(await prisma.serviceCheckJob.count(), 0);
        const queued = await exec(process.execPath, ['src/cli.ts', 'check', '1'], { cwd, env });
        const eligible = await prisma.service.count({ where: { dashboard: { monitoringEnabled: true }, OR: [{ http: true }, { https: true }] } });
        assert.match(queued.stdout, new RegExp(`Scheduled ${eligible} missing availability jobs`));
        await exec(process.execPath, ['src/cli.ts', 'check', '5'], { cwd, env });
        assert.equal(await prisma.serviceCheckJob.count(), eligible);
        const verified = await exec(process.execPath, ['src/cli.ts', 'verify', 'queue'], { cwd, env });
        assert.match(verified.stdout, /PostgreSQL connection OK/);
        assert.match(verified.stdout, new RegExp(`pending: ${eligible}`));
        await assert.rejects(exec(process.execPath, ['src/cli.ts', 'check', '2'], { cwd, env }), /Usage:/);

        const browserless = createServer((incoming, response) => {
          assert.equal(incoming.method, 'POST');
          assert.equal(incoming.url, '/screenshot?token=test-token');
          response.writeHead(200, { 'Content-Type': 'image/png' });
          response.end(Buffer.from('iVBORw0KGgpmaXh0dXJl', 'base64'));
        });
        browserless.listen(0, '127.0.0.1');
        await new Promise<void>(resolve => browserless.once('listening', resolve));
        try {
          const address = browserless.address();
          assert.ok(address && typeof address !== 'string');
          const checked = await exec(process.execPath, ['src/cli.ts', 'verify', 'chrome'], { cwd,
            env: { ...env, STAKEOUT_SERVER_CHROME_URL: `ws://127.0.0.1:${address.port}`, STAKEOUT_SERVER_CHROME_TOKEN: 'test-token' } });
          assert.match(checked.stdout, /returned PNG \(OK\)/);
        } finally {
          await close(browserless);
        }
      });
    } finally {
      await close(server);
      await prisma.$disconnect();
    }
  });
});
