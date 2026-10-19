// Author: Preston Lee

import express, { type ErrorRequestHandler, type Request } from 'express';
import cors from 'cors';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Prisma, type PrismaClient, type Dashboard, type Service } from '@prisma/client';
import type { StatusDto } from '@stakeout/core';
import { ApiError, attributes, notFound, nullableString, railsBoolean, requireUuid, validatePresence } from './api/errors.ts';
import { dashboardAttributes, dashboardDto, serviceDto, serviceMutationDto } from './api/serialization.ts';

export interface AppConfig {
  username: string;
  password: string;
  corsOrigin: string;
  trustProxy: boolean | string;
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

function authenticated(request: Request, config: AppConfig): boolean {
  if (!config.username || !config.password) return false;
  const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/i.exec(request.get('authorization') ?? '');
  if (!match) return false;
  const credentials = Buffer.from(match[1] ?? '', 'base64').toString('utf8');
  const expected = `${config.username}:${config.password}`;
  return timingSafeEqual(createHash('sha256').update(credentials).digest(), createHash('sha256').update(expected).digest());
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

type WritableService = Pick<Service, 'name' | 'host' | 'port' | 'http' | 'https' | 'http_path' | 'http_xquery' | 'http_preview'>;

function serviceInput(input: Record<string, unknown>, existing?: Service): WritableService {
  const values: WritableService = existing ? {
    name: existing.name, host: existing.host, port: existing.port, http: existing.http,
    https: existing.https, http_path: existing.http_path, http_xquery: existing.http_xquery, http_preview: existing.http_preview,
  } : { name: '', host: '', port: 0, http: true, https: false, http_path: '', http_xquery: null, http_preview: true };
  for (const field of ['name', 'host'] as const) {
    const value = nullableString(input[field]);
    if (value !== undefined) values[field] = value ?? '';
  }
  const path = nullableString(input.http_path);
  if (path === null) throw new ApiError(422, { http_path: ["can't be null"] });
  if (path !== undefined) values.http_path = path;
  const xquery = nullableString(input.http_xquery);
  if (xquery !== undefined) values.http_xquery = xquery;
  for (const field of ['http', 'https', 'http_preview'] as const) {
    const value = railsBoolean(input[field]);
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
    ? await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM dashboards WHERE to_tsvector('simple', coalesce(name, '')) @@ ${expression}`)
    : await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM services WHERE dashboard_id = ${dashboardId}::uuid AND to_tsvector('simple', name) @@ ${expression}`);
  return rows.map(row => row.id);
}

export function createApp({ prisma, config, enqueueDashboardChecks = async () => 0 }: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(cors({ origin: config.corsOrigin === '*' ? '*' : config.corsOrigin.split(',').map(origin => origin.trim()),
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], exposedHeaders: ['Location'] }));

  // Operational readiness is independent of Rails' JSON content negotiation.
  app.get('/health', async (_request, response) => {
    await prisma.$queryRaw`SELECT 1`;
    response.json({ status: 'ok' });
  });

  app.use((request, response, next) => {
    const queryIndex = request.url.indexOf('?');
    const path = queryIndex < 0 ? request.url : request.url.slice(0, queryIndex);
    if (path.endsWith('.json')) {
      request.url = `${path.slice(0, -5)}${queryIndex < 0 ? '' : request.url.slice(queryIndex)}`;
      next();
      return;
    }
    if (!/application\/json/i.test(request.get('accept') ?? '')) {
      response.status(406).json({ message: "This service only responds to JSON requests. Please set your 'Accept' header to 'application/json'." });
      return;
    }
    next();
  });
  app.use((request, response, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !authenticated(request, config)) {
      response.status(401).json({ message: 'HTTP Basic: Access denied.' });
      return;
    }
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

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
  app.post('/test', status);

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
    const dashboard = await prisma.dashboard.create({ data: { name, created_at: now, updated_at: now } });
    response.location(`${request.protocol}://${request.host}/dashboards/${dashboard.id}`).status(201).json(dashboardAttributes(dashboard));
  });
  const updateDashboard = async (request: Request, response: express.Response) => {
    const id = parameter(request, 'id');
    const existing = await prisma.dashboard.findUnique({ where: { id } });
    if (!existing) notFound();
    const input = attributes(request.body, 'dashboard');
    const name = nullableString(input.name);
    validatePresence({ name: name === undefined ? existing.name : name });
    const dashboard = await prisma.dashboard.update({ where: { id }, data: { ...(name === undefined ? {} : { name }), updated_at: timestamp(existing.updated_at) } });
    response.json(dashboardAttributes(dashboard));
  };
  app.put('/dashboards/:id', updateDashboard);
  app.patch('/dashboards/:id', updateDashboard);
  app.delete('/dashboards/:id', async (request, response) => {
    const id = parameter(request, 'id');
    await prisma.$transaction(async transaction => {
      const dashboard = await transaction.dashboard.findUnique({ where: { id } });
      if (!dashboard) notFound();
      await transaction.service.deleteMany({ where: { dashboard_id: id } });
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
    const service = await prisma.service.findFirst({ where: { id: parameter(request, 'id'), dashboard_id: dashboardId } });
    if (!service) notFound();
    return service;
  }

  app.get('/dashboards/:dashboardId/services', async (request, response) => {
    const dashboard = await dashboardFor(request);
    const text = query(request, 'text');
    const ids = text === undefined ? undefined : await searchIds(prisma, text, dashboard.id);
    const sort = query(request, 'sort');
    const field = sort === 'created_at' || sort === 'updated_at' ? sort : 'name';
    const services = await prisma.service.findMany({
      where: { dashboard_id: dashboard.id, ...(ids === undefined ? {} : { id: { in: ids } }) },
      orderBy: { [field]: query(request, 'order') === 'desc' ? 'desc' : 'asc' },
    });
    await enqueueDashboardChecks(dashboard.id);
    const screenshots = query(request, 'screenshots') === 'true';
    response.json(services.map(service => serviceDto(service, request, screenshots)));
  });
  app.get('/dashboards/:dashboardId/services/:id', async (request, response) => {
    const dashboard = await dashboardFor(request);
    response.json(serviceDto(await serviceFor(request, dashboard.id), request));
  });
  app.post('/dashboards/:dashboardId/services', async (request, response) => {
    const dashboard = await dashboardFor(request);
    const input = serviceInput(attributes(request.body, 'service'));
    const now = timestamp(dashboard.updated_at);
    const service = await prisma.$transaction(async transaction => {
      const created = await transaction.service.create({ data: { ...input, dashboard_id: dashboard.id, created_at: now, updated_at: now } });
      await transaction.dashboard.update({ where: { id: dashboard.id }, data: { updated_at: now } });
      return created;
    });
    response.location(`${request.protocol}://${request.host}/dashboards/${dashboard.id}/services/${service.id}`).status(201).json(serviceMutationDto(service));
  });
  const updateService = async (request: Request, response: express.Response) => {
    const dashboard = await dashboardFor(request);
    const existing = await serviceFor(request, dashboard.id);
    const input = serviceInput(attributes(request.body, 'service'), existing);
    const changes: Partial<WritableService> = {};
    for (const field of Object.keys(input) as (keyof WritableService)[]) {
      if (input[field] !== existing[field]) Object.assign(changes, { [field]: input[field] });
    }
    const now = timestamp(existing.updated_at > dashboard.updated_at ? existing.updated_at : dashboard.updated_at);
    const service = await prisma.$transaction(async transaction => {
      const updated = await transaction.service.update({ where: { id: existing.id }, data: {
        ...changes, checked_at: null, http_screenshot: null, updated_at: now,
      } });
      await transaction.dashboard.update({ where: { id: dashboard.id }, data: { updated_at: now } });
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
      await transaction.service.delete({ where: { id: service.id } });
      await transaction.dashboard.update({ where: { id: dashboard.id }, data: { updated_at: timestamp(dashboard.updated_at) } });
    });
    response.status(204).end();
  });

  app.use((_request, response) => response.status(404).json({ message: 'Record not found.' }));
  const handleError: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof ApiError) { response.status(error.status).json(error.body); return; }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') { response.status(422).json({ name: ['has already been taken'] }); return; }
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
