import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import sharp from 'sharp';
import type { ServiceDto } from '@stakeout/core';
import { bootstrapDatabase } from '../src/bootstrap.ts';
import { createPrisma } from '../src/db/prisma.ts';
import { bootstrapUser } from '../src/auth/accounts.ts';
import type { SessionDto } from '@stakeout/core';
import { createApp } from '../src/app.ts';
import { createScreenshotPreview, screenshotHash } from '../src/screenshots.ts';
import { withPostgres } from './postgres.ts';

test('square WebP previews retain the full capture and are smaller than originals', async () => {
  const image = await sharp(Buffer.from(`<svg width="1280" height="1280"><rect width="1280" height="1280" fill="white"/>
    <text x="50" y="150" font-size="80">Service dashboard</text><rect x="50" y="250" width="1000" height="700" fill="#abcdef"/></svg>`)).png().toBuffer();
  const preview = await createScreenshotPreview(image);
  const metadata = await sharp(preview).metadata();
  assert.equal(metadata.width, 600);
  assert.equal(metadata.height, 600);
  assert.equal(metadata.format, 'webp');
  assert.ok(preview.length < image.length);
  // Old, non-square captures must also produce square previews without cropping.
  const rectangular = await sharp({ create: { width: 800, height: 400, channels: 3, background: 'red' } }).png().toBuffer();
  const square = await sharp(await createScreenshotPreview(rectangular)).metadata();
  assert.equal(square.width, square.height);
});

test('screenshot URLs cache independently, preserve legacy API and invalidate on actual image changes', { timeout: 180_000 }, async t => {
  await withPostgres(async databaseUrl => {
    await bootstrapDatabase(databaseUrl);
    const prisma = createPrisma(databaseUrl);
    await bootstrapUser(prisma, { bootstrapUsername: 'admin', bootstrapPassword: 'test-password-123' });
    let enqueued = 0;
    const app = createApp({ prisma, config: { production: false, corsOrigin: 'http://localhost:4200', trustProxy: true },
      enqueueDashboardChecks: async () => ++enqueued });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${origin}/auth/login`, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test-password-123' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const csrf = ((await login.json()) as SessionDto).csrfToken;
    const now = new Date();
    try {
      const dashboard = await prisma.dashboard.create({ data: { name: 'Images', createdAt: now, updatedAt: now } });
      const other = await prisma.dashboard.create({ data: { name: 'Other', createdAt: now, updatedAt: now } });
      const png = await sharp({ create: { width: 1280, height: 1280, channels: 3, background: 'white' } }).png().toBuffer();
      const hash = screenshotHash(png);
      const service = await prisma.service.create({ data: { dashboardId: dashboard.id, name: 'Website', host: 'example.test',
        httpScreenshot: new Uint8Array(png), httpScreenshotHash: hash, createdAt: now, updatedAt: now } });
      const listPath = `/dashboards/${dashboard.id}/services`;
      const list = async (mode: string) => {
        const response = await fetch(`${origin}${listPath}?screenshots=${mode}`, { headers: { Accept: 'application/json' } });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-cache');
        return (await response.json()) as ServiceDto[];
      };
      const urls = (await list('urls'))[0];
      assert.ok(urls.screenshot);
      assert.equal('http_screenshot' in urls, false);
      const { preview_url: previewUrl, original_url: originalUrl } = urls.screenshot;
      assert.ok(previewUrl.includes(hash));

      await t.test('generating a legacy preview does not invalidate an in-flight worker revision', async () => {
        const revision = async () => (await prisma.$queryRaw<{ revision: string }[]>`
          SELECT xmin::text AS revision FROM "Service" WHERE id = ${service.id}::uuid`)[0].revision;
        const before = await revision();
        assert.equal((await fetch(previewUrl)).status, 200);
        assert.equal(await revision(), before, 'image reads must not invalidate worker optimistic locking');
      });

      await t.test('binary image requests bypass JSON negotiation and support HEAD/304 without changing legacy data', async () => {
        const response = await fetch(previewUrl, { headers: { Accept: 'image/webp,image/*' } });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'image/webp');
        assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
        const bytes = Buffer.from(await response.arrayBuffer());
        const metadata = await sharp(bytes).metadata();
        assert.equal(metadata.width, 600);
        assert.equal(metadata.height, 600);
        const stored = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
        assert.equal(stored.httpScreenshotPreview, null);
        assert.deepEqual(Buffer.from(stored.httpScreenshot!), png);
        const cached = await fetch(previewUrl, { headers: { 'If-None-Match': response.headers.get('etag')!, 'Cache-Control': 'max-age=0' } });
        assert.equal(cached.status, 304);
        assert.equal((await cached.arrayBuffer()).byteLength, 0);
        const head = await fetch(originalUrl, { method: 'HEAD' });
        assert.equal(head.status, 200);
        assert.equal(head.headers.get('content-type'), 'image/png');
        assert.equal((await head.arrayBuffer()).byteLength, 0);
        const original = await fetch(originalUrl);
        assert.deepEqual(Buffer.from(await original.arrayBuffer()), png);
      });

      await t.test('status and timestamp changes reuse URLs; hidden screenshots and legacy responses retain their contracts', async () => {
        await prisma.service.update({ where: { id: service.id }, data: { checkedAt: new Date(), httpPathLast: true, updatedAt: new Date() } });
        assert.deepEqual((await list('urls'))[0].screenshot, urls.screenshot);
        assert.equal('screenshot' in (await list('false'))[0], false);
        const legacy = (await list('true'))[0];
        assert.equal('screenshot' in legacy, false);
        assert.deepEqual(Buffer.from(legacy.http_screenshot!, 'base64'), png);
        const noChange = await fetch(`${origin}${listPath}?screenshots=urls`, { headers: { Accept: 'application/json' } });
        await noChange.arrayBuffer();
        const count = enqueued;
        const conditional = await fetch(`${origin}${listPath}?screenshots=urls`, {
          headers: { Accept: 'application/json', 'If-None-Match': noChange.headers.get('etag')!, 'Cache-Control': 'max-age=0' },
        });
        assert.equal(conditional.status, 304);
        assert.equal(enqueued, count + 1, 'conditional polling must still enqueue stale checks');
      });

      await t.test('captures completing after metadata reads redirect old URLs without caching the redirect', async () => {
        const updatedPng = await sharp(png).negate().png().toBuffer();
        await prisma.service.update({ where: { id: service.id }, data: {
          httpScreenshot: new Uint8Array(updatedPng), httpScreenshotHash: screenshotHash(updatedPng), httpScreenshotPreview: null,
        } });
        assert.notDeepEqual((await list('urls'))[0].screenshot, urls.screenshot);
        const next = (await list('urls'))[0].screenshot!;
        for (const [oldUrl, currentUrl] of [[originalUrl, next.original_url], [previewUrl, next.preview_url]]) {
          const moved = await fetch(oldUrl, { redirect: 'manual' });
          assert.equal(moved.status, 302);
          assert.equal(moved.headers.get('cache-control'), 'no-store');
          assert.equal(new URL(moved.headers.get('location')!, origin).href, currentUrl);
          const followed = await fetch(oldUrl);
          assert.equal(followed.status, 200);
          assert.equal(followed.url, currentUrl);
        }
        const followedOriginal = await fetch(originalUrl);
        assert.deepEqual(Buffer.from(await followedOriginal.arrayBuffer()), updatedPng);
        assert.equal((await fetch(next.preview_url)).status, 200);
        assert.equal((await fetch(next.original_url.replace(dashboard.id, other.id))).status, 404);
        assert.equal((await fetch(next.original_url.replace('/original.png', '/anything.webp'))).status, 404);
        assert.equal((await fetch(next.original_url.replace(service.id, 'invalid'))).status, 404);
      });

      await t.test('editing invalidates originals, hashes and previews together', async () => {
        const response = await fetch(`${origin}${listPath}/${service.id}`, {
          method: 'PATCH', headers: { Accept: 'application/json', 'Content-Type': 'application/json',
            Cookie: cookie, 'X-CSRF-Token': csrf },
          body: JSON.stringify({ service: { host: 'changed.test' } }),
        });
        assert.equal(response.status, 200);
        const stored = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
        assert.equal(stored.httpScreenshot, null);
        assert.equal(stored.httpScreenshotHash, null);
        assert.equal(stored.httpScreenshotPreview, null);
        assert.equal((await list('urls'))[0].screenshot, null);
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await prisma.$disconnect();
    }
  });
});
