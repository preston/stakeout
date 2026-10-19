// Author: Preston Lee

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { SessionDto, UserDto } from '@stakeout/core';
import { createApp } from '../src/app.ts';
import { bootstrapDatabase } from '../src/bootstrap.ts';
import { createPrisma } from '../src/db/prisma.ts';
import { bootstrapUser, hashPassword, tokenHash, verifyPassword } from '../src/auth/accounts.ts';
import { readConfig } from '../src/config.ts';
import { withPostgres } from './postgres.ts';

const password = 'initial-password-123';
const origin = 'http://localhost:4200';
interface Handle { cookie: string; dto: SessionDto; }

async function fixture(action: (context: {
  prisma: ReturnType<typeof createPrisma>;
  request: (path: string, method?: string, body?: unknown, handle?: Handle, headers?: Record<string, string>) => Promise<Response>;
  login: (username: string, password?: string) => Promise<Handle>;
}) => Promise<void>) {
  await withPostgres(async url => {
    await bootstrapDatabase(url);
    const prisma = createPrisma(url);
    await bootstrapUser(prisma, { bootstrapUsername: 'admin', bootstrapPassword: password });
    const server = createApp({ prisma, config: { production: false, corsOrigin: origin, trustProxy: false } }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const request = (path: string, method = 'GET', body?: unknown, handle?: Handle, headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
      method, headers: { Accept: 'application/json', Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(handle ? { Cookie: handle.cookie, 'X-CSRF-Token': handle.dto.csrfToken } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const login = async (username: string, pw = password): Promise<Handle> => {
      const response = await request('/auth/login', 'POST', { username, password: pw });
      assert.equal(response.status, 200, await response.clone().text());
      const cookie = response.headers.get('set-cookie')!;
      assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/);
      assert.doesNotMatch(cookie, /Secure/);
      return { cookie: cookie.split(';')[0], dto: await response.json() as SessionDto };
    };
    try { await action({ prisma, request, login }); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await prisma.$disconnect(); }
  });
}

test('configuration requires paired bootstrap values and explicit origins', () => {
  const base = { STAKEOUT_SERVER_DATABASE_URL: 'postgresql://unused/unused' };
  assert.throws(() => readConfig({ ...base, STAKEOUT_SERVER_BOOTSTRAP_USERNAME: 'admin' }), /together/);
  assert.throws(() => readConfig({ ...base, STAKEOUT_SERVER_CORS_ORIGIN: '*' }));
  assert.equal(readConfig(base).corsOrigin, origin);
  assert.equal(readConfig(base).trustProxy, false);
  assert.equal(readConfig({ ...base, STAKEOUT_SERVER_TRUST_PROXY: '1' }).trustProxy, 1);
  assert.equal(readConfig({ ...base, STAKEOUT_SERVER_TRUST_PROXY: 'loopback' }).trustProxy, 'loopback');
});

test('scrypt hashes are salted, accept Unicode passwords, and reject malformed hashes', async () => {
  const secret = 'a secure 🔑 password';
  const first = await hashPassword(secret), second = await hashPassword(secret);
  assert.notEqual(first, second); assert.equal(await verifyPassword(secret, first), true);
  assert.equal(await verifyPassword('incorrect password', first), false);
  assert.equal(await verifyPassword(secret, 'invalid'), false);
  await assert.rejects(hashPassword('short'), /Validation failed/);
});

test('accounts, cookie sessions, settings, revocation and login protections', { timeout: 180_000 }, async t => {
  await fixture(async ({ prisma, request, login }) => {
    let admin = await login(' ADMIN ');
    const adminId = admin.dto.user.id;
    await t.test('only token hashes are stored and session responses omit credentials', async () => {
      const raw = admin.cookie.split('=')[1];
      const stored = await prisma.session.findUniqueOrThrow({ where: { tokenHash: tokenHash(raw) } });
      assert.notEqual(stored.tokenHash, raw);
      assert.ok(stored.expiresAt.getTime() > Date.now() + 6 * 86400000);
      assert.equal((await request('/auth/session', 'GET', undefined, admin)).status, 200);
      assert.equal('passwordHash' in admin.dto.user, false);
      assert.equal('tokenHash' in admin.dto, false);
    });
    await t.test('sessions work in a reconstructed API and production cookies are secure', async () => {
      const server = createApp({ prisma, config: { production: true, corsOrigin: origin, trustProxy: false } }).listen(0, '127.0.0.1');
      await once(server, 'listening');
      try {
        const address = server.address(); assert.ok(address && typeof address !== 'string');
        const base = `http://127.0.0.1:${address.port}`;
        const restored = await fetch(`${base}/auth/session`, { headers: { Accept: 'application/json', Cookie: admin.cookie } });
        assert.equal(restored.status, 200);
        const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ username: 'admin', password }) });
        assert.equal(response.status, 200);
        assert.match(response.headers.get('set-cookie')!, /Secure/);
        assert.match(response.headers.get('set-cookie')!, /SameSite=None/);
      } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    });
    await t.test('public reads remain public, Basic credentials do not authorize administration', async () => {
      for (const path of ['/dashboards', '/status', '/health']) assert.equal((await request(path)).status, 200);
      assert.equal((await request('/admin/users')).status, 401);
      assert.equal((await request('/dashboards', 'POST', { dashboard: { name: 'No' } }, undefined, { Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` })).status, 401);
      assert.equal((await request('/test', 'POST', {}, admin)).status, 404);
    });
    await t.test('CSRF, Origin and CORS distinguish trusted credentialed requests', async () => {
      for (const csrf of ['', 'bad', 'é'.repeat(64), 'a'.repeat(64)]) {
        assert.equal((await request('/users/me', 'PATCH', { displayName: 'No' }, admin, { 'X-CSRF-Token': csrf })).status, 403);
      }
      assert.equal((await request('/users/me', 'PATCH', { displayName: 'No' }, admin, { Origin: 'https://evil.example' })).status, 403);
      assert.equal((await request('/auth/login', 'POST', { username: 'admin', password }, undefined, { Origin: 'https://evil.example' })).status, 403);
      const response = await request('/admin/users', 'GET', undefined, admin);
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
      assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const denied = await request('/dashboards', 'GET', undefined, undefined, { Origin: 'https://evil.example' });
      assert.equal(denied.headers.get('access-control-allow-origin'), null);
    });
    await t.test('self profile and preference validation persist user-specific values', async () => {
      assert.equal((await request('/users/me', 'PATCH', { displayName: 'Administrator', isActive: false }, admin)).status, 200);
      assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: adminId } })).isActive, true);
      const saved = await request('/users/me/settings', 'PATCH', { developer: true, refreshIntervalMs: 5000, screenshots: false, displayMode: 'wide', themePreferred: 'dark', serviceSort: 'updatedAt', serviceOrder: 'desc', dashboardOrder: 'desc', experimental: true }, admin);
      assert.equal(saved.status, 200);
      assert.equal((await login('admin')).dto.preferences.refreshIntervalMs, 5000);
      assert.equal((await request('/users/me/settings', 'PATCH', { developer: false }, admin)).status, 200);
      assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: adminId } })).refreshIntervalMs, 60000);
      for (const body of [{ themePreferred: 'invalid' }, { developer: 'true' }, { refreshIntervalMs: -1 }, { passwordHash: 'injected' }]) assert.equal((await request('/users/me/settings', 'PATCH', body, admin)).status, 422);
    });
    let member: UserDto;
    await t.test('every authenticated user can create and manage accounts; duplicate usernames normalize', async () => {
      const created = await request('/admin/users', 'POST', { username: 'Member', displayName: 'Member', password, isActive: true }, admin);
      assert.equal(created.status, 201); member = await created.json() as UserDto;
      assert.equal(member.username, 'member'); assert.equal('passwordHash' in member, false);
      const duplicate = await request('/admin/users', 'POST', { username: ' MEMBER ', displayName: 'Duplicate', password }, admin);
      assert.equal(duplicate.status, 422); assert.ok('username' in await duplicate.json());
      const signedIn = await login('member');
      assert.equal(signedIn.dto.preferences.themePreferred, 'automatic');
      assert.equal((await request('/admin/users', 'GET', undefined, signedIn)).status, 200);
      const renamed = await request(`/admin/users/${member.id}`, 'PATCH', { username: 'renamed', displayName: 'Renamed' }, admin);
      assert.equal(renamed.status, 200); assert.equal((await login('renamed')).dto.user.id, member.id);
    });
    await t.test('admin password reset and account disablement revoke sessions', async () => {
      const signedIn = await login('renamed');
      assert.equal((await request(`/admin/users/${member.id}/password`, 'POST', { password: 'replacement-password-123' }, admin)).status, 204);
      assert.equal((await request('/auth/session', 'GET', undefined, signedIn)).status, 401);
      const replacement = await login('renamed', 'replacement-password-123');
      assert.equal((await request(`/admin/users/${member.id}`, 'PATCH', { isActive: false }, admin)).status, 200);
      assert.equal((await request('/auth/session', 'GET', undefined, replacement)).status, 401);
      const disabled = await request('/auth/login', 'POST', { username: 'renamed', password: 'replacement-password-123' });
      const unknown = await request('/auth/login', 'POST', { username: 'unknown', password });
      assert.equal(disabled.status, 401); assert.deepEqual(await disabled.json(), await unknown.json());
      assert.equal((await request(`/admin/users/${adminId}`, 'PATCH', { isActive: false }, admin)).status, 422);
      assert.equal((await request(`/admin/users/${adminId}`, 'DELETE', undefined, admin)).status, 422);
      assert.equal((await request(`/admin/users/${member.id}`, 'DELETE', undefined, admin)).status, 204);
      assert.equal(await prisma.session.count({ where: { userId: member.id } }), 0);
    });
    await t.test('personal password changes verify current password, replace the cookie and revoke other sessions', async () => {
      const other = await login('admin');
      assert.equal((await request('/users/me/password', 'POST', { currentPassword: 'wrong', password: 'changed-password-123' }, admin)).status, 422);
      const response = await request('/users/me/password', 'POST', { currentPassword: password, password: 'changed-password-123' }, admin);
      assert.equal(response.status, 200);
      const replacement = { cookie: response.headers.get('set-cookie')!.split(';')[0], dto: await response.json() as SessionDto };
      assert.notEqual(replacement.cookie, admin.cookie);
      assert.equal((await request('/auth/session', 'GET', undefined, other)).status, 401);
      assert.equal((await request('/auth/session', 'GET', undefined, admin)).status, 401);
      assert.equal((await request('/auth/session', 'GET', undefined, replacement)).status, 200);
      admin = replacement;
    });
    await t.test('logout and expiry revoke access without affecting public dashboards', async () => {
      const expiring = await login('admin', 'changed-password-123');
      await prisma.session.updateMany({ where: { tokenHash: tokenHash(expiring.cookie.split('=')[1]) }, data: { expiresAt: new Date(0) } });
      assert.equal((await request('/auth/session', 'GET', undefined, expiring)).status, 401);
      assert.equal((await request('/auth/logout', 'POST', {}, admin)).status, 204);
      assert.equal((await request('/auth/session', 'GET', undefined, admin)).status, 401);
      assert.equal((await request('/auth/logout', 'POST', {})).status, 204);
      assert.equal((await request('/dashboards')).status, 200);
    });
    await t.test('login failure limits are applied without revealing account existence', async () => {
      for (let i = 0; i < 10; i++) assert.equal((await request('/auth/login', 'POST', { username: 'throttled', password })).status, 401);
      assert.equal((await request('/auth/login', 'POST', { username: 'THROTTLED', password })).status, 429);
    });
  });
});

test('bootstrap is concurrent-safe, creates missing accounts and never overwrites existing users', { timeout: 180_000 }, async () => {
  await withPostgres(async url => {
    await bootstrapDatabase(url);
    const prisma = createPrisma(url);
    try {
      await assert.rejects(bootstrapUser(prisma, { bootstrapUsername: '', bootstrapPassword: '' }), /No users exist/);
      const config = { bootstrapUsername: 'Initial', bootstrapPassword: password };
      await Promise.all([bootstrapUser(prisma, config), bootstrapUser(prisma, config), bootstrapUser(prisma, config)]);
      assert.equal(await prisma.user.count(), 1);
      const original = await prisma.user.findUniqueOrThrow({ where: { username: 'initial' } });
      await prisma.user.update({ where: { id: original.id }, data: { isActive: false, displayName: 'Changed', themePreferred: 'dark' } });
      await bootstrapUser(prisma, { ...config, bootstrapPassword: 'a different password' });
      const after = await prisma.user.findUniqueOrThrow({ where: { id: original.id } });
      assert.equal(after.passwordHash, original.passwordHash); assert.equal(after.isActive, false); assert.equal(after.themePreferred, 'dark'); assert.equal(after.displayName, 'Changed');
      await bootstrapUser(prisma, { bootstrapUsername: '', bootstrapPassword: '' });
      await prisma.user.delete({ where: { id: original.id } });
      await bootstrapUser(prisma, config);
      assert.notEqual((await prisma.user.findUniqueOrThrow({ where: { username: 'initial' } })).id, original.id);
    } finally { await prisma.$disconnect(); }
  });
});

test('concurrent account removals retain an active administrator', { timeout: 180_000 }, async () => {
  await fixture(async ({ request, login, prisma }) => {
    const admin = await login('admin');
    await request('/admin/users', 'POST', { username: 'second', displayName: 'Second', password }, admin);
    const second = await login('second');
    const results = await Promise.all([
      request(`/admin/users/${admin.dto.user.id}`, 'DELETE', undefined, admin),
      request(`/admin/users/${second.dto.user.id}`, 'PATCH', { isActive: false }, second),
    ]);
    assert.equal(results.filter(r => r.status === 422).length, 1);
    assert.equal(results.filter(r => [200, 204].includes(r.status)).length, 1);
    assert.equal(await prisma.user.count({ where: { isActive: true } }), 1);
  });
});


test('login source limits cannot be bypassed by rotating usernames or spoofing forwarded addresses', { timeout: 180_000 }, async () => {
  await fixture(async ({ request }) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const response = await request('/auth/login', 'POST', { username: `unknown-${attempt}`, password: null }, undefined, { 'X-Forwarded-For': `192.0.2.${attempt + 1}` });
      assert.equal(response.status, 401);
    }
    assert.equal((await request('/auth/login', 'POST', { username: 'another-username', password: null })).status, 429);
  });
});
