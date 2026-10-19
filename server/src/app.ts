// Author: Preston Lee

import express, { type ErrorRequestHandler, type Request } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { accountRouter, authentication, mutations } from './auth/routes.ts';
import { Prisma, type PrismaClient, type Dashboard, type Service } from '@prisma/client';
import type { StatusDto } from '@stakeout/core';
import { ApiError, attributes, notFound, nullableString, railsBoolean, requireUuid, validatePresence } from './api/errors.ts';
import { dashboardAttributes, dashboardDto, serviceDto, serviceMutationDto } from './api/serialization.ts';
import { createScreenshotPreview, PREVIEW_FILENAME } from './screenshots.ts';
import { historyRouter, screenshotDemandRouter } from './history/routes.ts';
import { prismaHistoryDatabase, reconcileServiceHistory } from './history/recording.ts';

export interface AppConfig {
  production: boolean;
  corsOrigin: string;
  trustProxy: boolean | number | string;
}

export interface AppOptions {
  prisma: PrismaClient;
  config: AppConfig;
  enqueueDashboardChecks?: (dashboardId: string) => Promise<number>;
}

function parameter(request: Request, key: string): string {
  const value = request.params[key];
  return requireUuid(typeof value === 'string' ? value : '');
}

function query(request: Request, key: string): string | undefined {
  const value = request.query[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ApiError(400, { message: `Invalid ${key} parameter.` });
  return value;
}


function timestamp(previous?: Date): Date {
  return new Date(Math.max(Date.now(), (previous?.getTime() ?? 0) + 1));
}

function localDatetime(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const shifted = new Date(date.getTime() + offset * 60_000).toISOString().slice(0, -1);
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const minutes = String(Math.abs(offset) % 60).padStart(2, '0');
  return `${shifted}${offset < 0 ? '-' : '+'}${hours}:${minutes}`;
}

type WritableService = Pick<Service, 'name' | 'host' | 'port' | 'http' | 'https' | 'httpPath' | 'httpXquery' | 'httpPreview'>;

function monitoringInput(input: Record<string, unknown>): Prisma.DashboardUpdateInput {
  const changes: Record<string, unknown> = {};
  for (const [json, field] of [['monitoring_enabled','monitoringEnabled'],['screenshots_enabled','screenshotsEnabled']] as const) {
    if (!(json in input)) continue;
    if (typeof input[json] !== 'boolean') throw new ApiError(422, { [json]: ['must be a boolean'] });
    changes[field] = input[json];
  }
  for (const [json, field] of [['check_interval_seconds','checkIntervalSeconds'],['screenshot_interval_seconds','screenshotIntervalSeconds'],['hourly_retention_days','hourlyRetentionDays'],['daily_retention_days','dailyRetentionDays'],['availability_retention_days','availabilityRetentionDays']] as const) {
    if (!(json in input)) continue;
    const value = input[json];
    const retention = json.endsWith('_days');
    if (retention && value === null) { changes[field] = null; continue; }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > (retention ? 365_000 : 86_400)) throw new ApiError(422, { [json]: [retention ? 'must be a positive number of days or null' : 'must be an integer between 1 and 86400'] });
    changes[field] = value;
  }
  return changes;
}

async function lockDashboard(transaction: Prisma.TransactionClient, id: string) {
  await transaction.$queryRaw`SELECT id FROM "Dashboard" WHERE id=${id}::uuid FOR UPDATE`;
  const dashboard = await transaction.dashboard.findUnique({ where: { id } });
  if (!dashboard) notFound();
  return dashboard;
}

async function lockService(transaction: Prisma.TransactionClient, id: string, dashboardId: string) {
  await transaction.$queryRaw`SELECT id FROM "Service" WHERE id=${id}::uuid AND "dashboardId"=${dashboardId}::uuid FOR UPDATE`;
  const service = await transaction.service.findFirst({ where: { id, dashboardId } });
  if (!service) notFound();
  return service;
}

function serviceInput(input: Record<string, unknown>, existing?: Service): WritableService {
  const values: WritableService = existing ? {
    name: existing.name, host: existing.host, port: existing.port, http: existing.http,
    https: existing.https, httpPath: existing.httpPath, httpXquery: existing.httpXquery, httpPreview: existing.httpPreview,
  } : { name: '', host: '', port: 0, http: true, https: false, httpPath: '', httpXquery: null, httpPreview: true };
  for (const field of ['name', 'host'] as const) {
    const value = nullableString(input[field]);
    if (value !== undefined) values[field] = value ?? '';
  }
  const path = nullableString(input.http_path);
  if (path === null) throw new ApiError(422, { http_path: ["can't be null"] });
  if (path !== undefined) values.httpPath = path;
  const xquery = nullableString(input.http_xquery);
  if (xquery !== undefined) values.httpXquery = xquery;
  for (const field of ['http', 'https', 'httpPreview'] as const) {
    const value = railsBoolean(input[field === 'httpPreview' ? 'http_preview' : field]);
    if (value !== undefined) values[field] = value;
  }
  if ('port' in input) {
    const port = typeof input.port === 'number' ? input.port : typeof input.port === 'string' && /^\d+$/.test(input.port) ? Number(input.port) : NaN;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ApiError(422, { port: ['must be an integer between 0 and 65535'] });
    values.port = port;
  }
  validatePresence({ name: values.name, host: values.host });
  return values;
}

async function searchIds(prisma: PrismaClient, text: string, dashboardId?: string): Promise<string[]> {
  // Match pg_search's simple-dictionary, all-words prefix search in PostgreSQL.
  const expression = Prisma.sql`to_tsquery('simple', (SELECT string_agg(quote_literal(lexeme) || ':*', ' & ') FROM unnest(tsvector_to_array(to_tsvector('simple', ${text}))) lexeme))`;
  const rows = dashboardId === undefined
    ? await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM "Dashboard" WHERE to_tsvector('simple', coalesce(name, '')) @@ ${expression}`)
    : await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM "Service" WHERE "dashboardId" = ${dashboardId}::uuid AND to_tsvector('simple', name) @@ ${expression}`);
  return rows.map(row => row.id);
}

export function createApp({ prisma, config, enqueueDashboardChecks = async () => 0 }: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(cors({ origin: config.corsOrigin.split(',').map(origin => origin.trim()), credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], exposedHeaders: ['Location'] }));

  // Operational readiness is independent of Rails' JSON content negotiation.
  app.get('/health', async (_request, response) => {
    await prisma.$queryRaw`SELECT 1`;
    response.json({ status: 'ok' });
  });

  // Image elements send image Accept headers; register these public reads before
  // the JSON-only negotiation middleware. Never serve newer bytes at an old URL.
  app.get('/dashboards/:dashboardId/services/:id/screenshots/:hash/:variant', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const hash = request.params['hash'];
    const variant = request.params['variant'];
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash) ||
      (variant !== PREVIEW_FILENAME && variant !== 'original.png')) notFound();
    const serviceId = parameter(request, 'id');
    const dashboardId = parameter(request, 'dashboardId');
    const service = await prisma.service.findFirst({
      where: { id: serviceId, dashboardId: dashboardId },
      select: { httpScreenshotHash: true, httpScreenshot: true, httpScreenshotPreview: true },
    });
    if (!service?.httpScreenshot || !service.httpScreenshotHash) notFound();
    if (service.httpScreenshotHash !== hash) {
      // A capture can finish after the metadata response but before the image
      // request. Redirect to its canonical URL without caching this old version.
      response.redirect(302, `/dashboards/${dashboardId}/services/${serviceId}/screenshots/${service.httpScreenshotHash}/${variant}`);
      return;
    }
    let image: Uint8Array = service.httpScreenshot;
    if (variant === PREVIEW_FILENAME) {
      if (service.httpScreenshotPreview) {
        image = service.httpScreenshotPreview;
      } else {
        try { image = await createScreenshotPreview(image); }
        catch { notFound(); }
        // Keep legacy reads free of writes: changing xmin here would cancel a
        // worker's in-flight capture. The next worker check stores its preview.
      }
    }
    response.set({ 'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: `"${hash}-${variant}"`, 'X-Content-Type-Options': 'nosniff' });
    response.type(variant === PREVIEW_FILENAME ? 'image/webp' : 'image/png').send(Buffer.from(image));
  });

  app.use((request, response, next) => {
    const queryIndex = request.url.indexOf('?');
    const path = queryIndex < 0 ? request.url : request.url.slice(0, queryIndex);
    if (request.method === 'GET' && /^\/dashboards\/[0-9a-f-]+\/history\/export\.csv$/i.test(path)) { next(); return; }
    if (path.endsWith('.json')) {
      request.url = `${path.slice(0, -5)}${queryIndex < 0 ? '' : request.url.slice(queryIndex)}`;
      next();
      return;
    }
    if (request.query['format'] !== 'json' && !/application\/json/i.test(request.get('accept') ?? '')) {
      response.status(406).json({ message: "This service only responds to JSON requests. Please set your 'Accept' header to 'application/json'." });
      return;
    }
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(cookieParser());
  app.use(authentication(prisma, config));
  app.use(screenshotDemandRouter(prisma, config.corsOrigin));
  app.use(mutations(config));
  app.use(accountRouter(prisma, config));
  app.use(historyRouter(prisma));

  const status = async (_request: Request, response: express.Response) => {
    const [row] = await prisma.$queryRaw<{ datetime: Date }[]>`SELECT CURRENT_TIMESTAMP AS datetime`;
    const body: StatusDto = {
      message: 'This application server and underlying database connection appear to be healthy.',
      server: { datetime: localDatetime(new Date()) },
      database: { datetime: (row?.datetime ?? new Date()).toISOString().replace(/Z$/, '+00:00') },
    };
    response.json(body);
  };
  app.get('/status', status);

  const dashboardIndex = async (request: Request, response: express.Response) => {
    const text = query(request, 'text');
    const ids = text === undefined ? undefined : await searchIds(prisma, text);
    const dashboards = await prisma.dashboard.findMany({
      where: ids === undefined ? {} : { id: { in: ids } },
      orderBy: { name: query(request, 'order') === 'desc' ? 'desc' : 'asc' },
    });
    response.json(dashboards.map(dashboard => dashboardDto(dashboard, request)));
  };
  app.get('/', dashboardIndex);
  app.get('/dashboards', dashboardIndex);
  app.get('/dashboards/:id', async (request, response) => {
    const dashboard = await prisma.dashboard.findUnique({ where: { id: parameter(request, 'id') } });
    if (!dashboard) notFound();
    response.json(dashboardDto(dashboard, request));
  });
  app.post('/dashboards', async (request, response) => {
    const input = attributes(request.body, 'dashboard');
    const name = nullableString(input.name);
    validatePresence({ name });
    const now = new Date();
    const dashboard = await prisma.dashboard.create({ data: { ...monitoringInput(input), name, createdAt: now, updatedAt: now } as Prisma.DashboardCreateInput });
    response.location(`${request.protocol}://${request.host}/dashboards/${dashboard.id}`).status(201).json(dashboardAttributes(dashboard));
  });
  const updateDashboard = async (request: Request, response: express.Response) => {
    const id = parameter(request, 'id');
    const input = attributes(request.body, 'dashboard');
    const name = nullableString(input.name);
    const settings = monitoringInput(input);
    const dashboard = await prisma.$transaction(async transaction => {
      const existing = await lockDashboard(transaction,id);
      validatePresence({ name: name === undefined ? existing.name : name });
      const changed = Object.entries(settings).some(([key,value]) => existing[key as keyof Dashboard] !== value);
      const services = changed ? await transaction.service.findMany({ where: { dashboardId: id }, select: { id: true }, orderBy: { id: 'asc' } }) : [];
      const at = new Date();
      const db = prismaHistoryDatabase(transaction);
      for (const service of services) { await lockService(transaction,service.id,id); await reconcileServiceHistory(db,service.id,at); }
      const updated = await transaction.dashboard.update({ where: { id }, data: { ...settings, ...(name === undefined ? {} : { name }), ...(changed ? { monitoringRevision: { increment: 1 } } : {}), updatedAt: timestamp(existing.updatedAt) } });
      if (updated.checkIntervalSeconds !== existing.checkIntervalSeconds) {
        await transaction.service.updateMany({ where: { dashboardId: id }, data: { availabilityCheckRequestedAt: at } });
      }
      for (const service of services) await reconcileServiceHistory(db,service.id,at);
      if (changed) await transaction.serviceCheckJob.updateMany({ where: { status: 'pending', service: { dashboardId: id } }, data: { availableAt: at } });
      return updated;
    }, { timeout: 60_000 });
    if (Object.keys(settings).length) await enqueueDashboardChecks(id);
    response.json(dashboardAttributes(dashboard));
  };
  app.put('/dashboards/:id', updateDashboard);
  app.patch('/dashboards/:id', updateDashboard);
  app.delete('/dashboards/:id', async (request, response) => {
    const id = parameter(request, 'id');
    await prisma.$transaction(async transaction => {
      await lockDashboard(transaction,id);
      await transaction.service.deleteMany({ where: { dashboardId: id } });
      await transaction.dashboard.delete({ where: { id } });
    });
    response.json(null);
  });

  async function dashboardFor(request: Request): Promise<Dashboard> {
    const dashboard = await prisma.dashboard.findUnique({ where: { id: parameter(request, 'dashboardId') } });
    if (!dashboard) notFound();
    return dashboard;
  }

  async function serviceFor(request: Request, dashboardId: string): Promise<Service> {
    const service = await prisma.service.findFirst({ where: { id: parameter(request, 'id'), dashboardId: dashboardId } });
    if (!service) notFound();
    return service;
  }

  app.get('/dashboards/:dashboardId/services', async (request, response) => {
    const dashboard = await dashboardFor(request);
    const text = query(request, 'text');
    const ids = text === undefined ? undefined : await searchIds(prisma, text, dashboard.id);
    const sort = query(request, 'sort');
    const screenshotMode = query(request, 'screenshots');
    const field = sort === 'created_at' ? 'createdAt' : sort === 'updated_at' ? 'updatedAt' : 'name';
    const services = await prisma.service.findMany({
      where: { dashboardId: dashboard.id, ...(ids === undefined ? {} : { id: { in: ids } }) },
      orderBy: { [field]: query(request, 'order') === 'desc' ? 'desc' : 'asc' },
      omit: { httpScreenshot: screenshotMode !== 'true', httpScreenshotPreview: true },
    });
    await enqueueDashboardChecks(dashboard.id);
    const screenshots = screenshotMode === 'urls' ? 'urls' : screenshotMode === 'true';
    response.set('Cache-Control', 'no-cache');
    response.json(services.map(service => serviceDto(service, request, screenshots)));
  });
  app.get('/dashboards/:dashboardId/services/:id', async (request, response) => {
    const dashboard = await dashboardFor(request);
    response.json(serviceDto(await serviceFor(request, dashboard.id), request));
  });
  app.post('/dashboards/:dashboardId/services', async (request, response) => {
    const dashboard = await dashboardFor(request);
    const input = serviceInput(attributes(request.body, 'service'));
    const service = await prisma.$transaction(async transaction => {
      const currentDashboard = await lockDashboard(transaction,dashboard.id);
      const now = timestamp(currentDashboard.updatedAt);
      const created = await transaction.service.create({ data: { ...input, dashboardId: dashboard.id, createdAt: now, updatedAt: now, historyStartedAt: now } });
      await reconcileServiceHistory(prismaHistoryDatabase(transaction),created.id,now);
      await transaction.dashboard.update({ where: { id: dashboard.id }, data: { updatedAt: now } });
      return created;
    });
    response.location(`${request.protocol}://${request.host}/dashboards/${dashboard.id}/services/${service.id}`).status(201).json(serviceMutationDto(service));
  });
  const updateService = async (request: Request, response: express.Response) => {
    const dashboard = await dashboardFor(request);
    const serviceId = parameter(request,'id');
    const attributesInput = attributes(request.body, 'service');
    const service = await prisma.$transaction(async transaction => {
      const currentDashboard = await lockDashboard(transaction,dashboard.id);
      const existing = await lockService(transaction,serviceId,dashboard.id);
      const input = serviceInput(attributesInput,existing);
      const changes: Partial<WritableService> = {};
      for (const field of Object.keys(input) as (keyof WritableService)[]) if (input[field] !== existing[field]) Object.assign(changes,{ [field]: input[field] });
      const targetChanged = ['host','port','http','https','httpPath','httpXquery'].some(field => field in changes);
      const now = timestamp(existing.updatedAt > currentDashboard.updatedAt ? existing.updatedAt : currentDashboard.updatedAt);
      const db = prismaHistoryDatabase(transaction);
      await reconcileServiceHistory(db,existing.id,now);
      const updated = await transaction.service.update({ where: { id: existing.id }, data: {
        ...changes, ...(targetChanged ? { configRevision: { increment: 1 }, checkedAt: null, httpPathLast: false, httpsPathLast: false, httpXqueryLast: false,
          httpScreenshot: null, httpScreenshotHash: null, httpScreenshotPreview: null, screenshotCheckedAt: null } : {}), updatedAt: now,
      } });
      await reconcileServiceHistory(db,existing.id,now);
      if (targetChanged || 'httpPreview' in changes) await transaction.serviceCheckJob.updateMany({ where: { serviceId: existing.id, status: 'pending' }, data: { availableAt: now } });
      await transaction.dashboard.update({ where: { id: dashboard.id }, data: { updatedAt: now } });
      return updated;
    });
    response.location(`${request.protocol}://${request.host}/dashboards/${dashboard.id}/services/${service.id}`).json(serviceMutationDto(service));
  };
  app.put('/dashboards/:dashboardId/services/:id', updateService);
  app.patch('/dashboards/:dashboardId/services/:id', updateService);
  app.delete('/dashboards/:dashboardId/services/:id', async (request, response) => {
    const dashboard = await dashboardFor(request);
    const service = await serviceFor(request, dashboard.id);
    await prisma.$transaction(async transaction => {
      const currentDashboard = await lockDashboard(transaction,dashboard.id);
      await lockService(transaction,service.id,dashboard.id);
      await transaction.service.delete({ where: { id: service.id } });
      await transaction.dashboard.update({ where: { id: dashboard.id }, data: { updatedAt: timestamp(currentDashboard.updatedAt) } });
    });
    response.status(204).end();
  });

  app.use((_request, response) => response.status(404).json({ message: 'Record not found.' }));
  const handleError: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (response.headersSent) { response.destroy(error instanceof Error ? error : undefined); return; }
    if (error instanceof ApiError) { response.status(error.status).json(error.body); return; }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') { response.status(422).json({ [error.meta?.modelName === 'User' ? 'username' : 'name']: ['has already been taken'] }); return; }
      if (error.code === 'P2025' || error.code === 'P2003') { response.status(404).json({ message: 'Record not found.' }); return; }
    }
    if (error instanceof SyntaxError && 'body' in error) { response.status(400).json({ message: 'Invalid JSON request.' }); return; }
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 413) {
      response.status(413).json({ message: 'Request body is too large.' }); return;
    }
    console.error('HTTP request failed', error);
    response.status(500).json({ message: 'Internal server error.' });
  };
  app.use(handleError);
  return app;
}
