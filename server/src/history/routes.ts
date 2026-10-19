import { Router, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { Prisma, type PrismaClient } from '@prisma/client';
import { ApiError, notFound, requireUuid } from '../api/errors.ts';
import { dashboardEvents, dashboardHistory, historyFilters, serviceHistory } from './queries.ts';

/** This deliberately narrow route is registered before the administrative mutation gate. */
export function screenshotDemandRouter(prisma: PrismaClient, corsOrigin: string) {
  const router = Router();
  const allowed = new Set(corsOrigin.split(',').map(origin => origin.trim()));
  const limiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { message: 'Too many preview requests. Try again shortly.' } });
  router.post('/dashboards/:dashboardId/screenshot-demand', limiter, async (request, response) => {
    const origin = request.get('origin');
    if (origin && !allowed.has(origin) && origin !== `${request.protocol}://${request.host}`) throw new ApiError(403, { message: 'This origin is not allowed.' });
    if (!request.is('application/json')) throw new ApiError(415, { message: 'Use application/json.' });
    const dashboardId = requireUuid(String(request.params.dashboardId));
    // One dashboard-level lease means additional viewers never multiply captures.
    const [dashboard] = await prisma.$queryRaw<{ screenshotsEnabled: boolean; screenshotDemandUntil: Date }[]>`UPDATE "Dashboard"
      SET "screenshotDemandUntil"=greatest(coalesce("screenshotDemandUntil",'epoch'::timestamptz),CURRENT_TIMESTAMP+interval '90 seconds')
      WHERE id=${dashboardId}::uuid RETURNING "screenshotsEnabled","screenshotDemandUntil"`;
    if (!dashboard) notFound();
    response.set('Cache-Control', 'no-store').json({ enabled: dashboard.screenshotsEnabled, expires_at: dashboard.screenshotDemandUntil.toISOString() });
  });
  return router;
}

export function csvCell(value: unknown): string {
  let text = value == null ? '' : String(value);
  // Spreadsheet applications execute formula-shaped fields even in quoted CSV.
  if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

async function writeCsv(response: Response, values: unknown[]) {
  if (response.destroyed) return;
  if (!response.write(`${values.map(csvCell).join(',')}\r\n`)) await new Promise<void>(resolve => {
    const finished = () => { response.off('drain',finished); response.off('close',finished); resolve(); };
    response.once('drain',finished); response.once('close',finished);
  });
}

export function historyRouter(prisma: PrismaClient) {
  const router = Router();
  router.use('/dashboards/:dashboardId', (_request, response, next) => { response.set('Cache-Control', 'no-store'); next(); });
  router.get('/dashboards/:dashboardId/history', async (request, response) => {
    response.json(await dashboardHistory(prisma, requireUuid(String(request.params.dashboardId)), historyFilters(request.query)));
  });
  router.get('/dashboards/:dashboardId/events', async (request, response) => {
    response.json(await dashboardEvents(prisma, requireUuid(String(request.params.dashboardId)), historyFilters(request.query)));
  });
  router.get('/dashboards/:dashboardId/services/:id/history', async (request, response) => {
    response.json(await serviceHistory(prisma, requireUuid(String(request.params.dashboardId)), requireUuid(String(request.params.id)), historyFilters(request.query)));
  });
  router.get('/dashboards/:dashboardId/history/export.csv', async (request: Request, response: Response) => {
    const dataset = request.query.dataset ?? 'services';
    if (dataset !== 'services' && dataset !== 'events') throw new ApiError(400, { message: 'Choose the services or events dataset.' });
    const dashboardId = requireUuid(String(request.params.dashboardId));
    const filters = { ...historyFilters(request.query), page: 1, limit: 100 };
    // Keep a single MVCC snapshot across pages: ordinary monitoring must not move
    // filtered rows between offsets while an export is being streamed.
    await prisma.$transaction(async transaction => {
      // Fetch before committing headers so missing dashboards still return JSON.
      let result = dataset === 'services' ? await dashboardHistory(transaction,dashboardId,filters) : await dashboardEvents(transaction,dashboardId,filters);
      if (response.destroyed) return;
      response.type('text/csv').set('Content-Disposition', `attachment; filename="stakeout-${dataset}.csv"`);
      await writeCsv(response, dataset === 'services'
        ? ['Service ID','Service','Host','Current state','From (UTC)','To (UTC)','Uptime (%)','Coverage (%)','Up (ms)','Degraded (ms)','Down (ms)','Unknown (ms)','Paused (ms)','Outages','Latest check (UTC)','HTTP average (ms)','HTTPS average (ms)']
        : ['Event ID','Service ID','Service','At (UTC)','State','Previous state','Kind','Reason','Configuration ID']);
      while (!response.destroyed) {
        if ('services' in result) for (const service of result.services) await writeCsv(response, [service.service_id,service.name,service.host,service.current_state,result.from,result.to,service.statistics.uptime_percent,service.statistics.coverage_percent,service.statistics.up_ms,service.statistics.degraded_ms,service.statistics.down_ms,service.statistics.unknown_ms,service.statistics.paused_ms,service.statistics.outage_count,service.latest_check_at,service.performance.http.average_ms,service.performance.https.average_ms]);
        else for (const event of result.events) await writeCsv(response,[event.id,event.service_id,event.service_name,event.at,event.state,event.previous_state,event.kind,event.reason,event.configuration_id]);
        if (response.destroyed || filters.page>=result.pagination.total_pages) break;
        filters.page++;
        result = dataset === 'services' ? await dashboardHistory(transaction,dashboardId,filters) : await dashboardEvents(transaction,dashboardId,filters);
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000, maxWait: 10_000 });
    response.end();
  });
  return router;
}
