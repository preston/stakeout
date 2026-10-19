import { Prisma, type PrismaClient } from '@prisma/client';
import type { AvailabilityStatistics, ProtocolPerformance, HistoryPagination, HistoryServiceSummary, HistoryResponse, EventsResponse, ServiceHistoryResponse, TimelineBucket, HistoryInterval, HistoryOutage, HistoryPerformanceBucket } from '@stakeout/core';
import { ApiError, notFound, requireUuid } from '../api/errors.ts';

/** Read APIs also accept a transaction client so exports can retain one snapshot. */
export type HistoryQueryClient = Pick<PrismaClient, 'dashboard' | '$queryRaw'>;

export interface HistoryFilters {
  from: Date; to: Date; now: Date; page: number; limit: number;
  serviceIds: string[]; state?: string; sort: string; order: 'asc' | 'desc';
  outagePage?: number; eventId?: string;
}

const states = new Set(['up', 'degraded', 'down', 'unknown', 'paused']);
export function historyFilters(input: Record<string, unknown>, now = new Date()): HistoryFilters {
  const scalar = (key: string) => {
    const value = input[key];
    if (value !== undefined && typeof value !== 'string') throw new ApiError(400, { message: `Invalid ${key} parameter.` });
    return value as string | undefined;
  };
  const date = (key: string, fallback: Date) => {
    const value = scalar(key);
    if (value === undefined) return fallback;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(value) || value.startsWith('0000-') || !Number.isFinite(Date.parse(value))) throw new ApiError(400, { message: `Invalid ${key}: use an ISO timestamp with a timezone.` });
    return new Date(value);
  };
  const integer = (key: string, fallback: number, maximum: number) => {
    const value = scalar(key);
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > maximum) throw new ApiError(400, { message: `Invalid ${key} parameter.` });
    return Number(value);
  };
  const to = date('to', now);
  const from = date('from', new Date(to.getTime() - 86_400_000));
  if (from >= to || to > now) throw new ApiError(400, { message: 'History requires from < to and to must not be in the future.' });
  const state = scalar('state');
  if (state && !states.has(state)) throw new ApiError(400, { message: 'Invalid state parameter.' });
  const serviceIds = scalar('service_id')?.split(',').filter(Boolean).map(requireUuid) ?? [];
  if (serviceIds.length > 100) throw new ApiError(400, { message: 'Select at most 100 services.' });
  const eventId = scalar('event_id')?.toLowerCase();
  if (eventId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:gap)?$/i.test(eventId)) throw new ApiError(400, { message: 'Invalid event_id parameter.' });
  return { from, to, now, page: integer('page', 1, 1_000_000), limit: integer('limit', 100, 100), serviceIds, state,
    outagePage: integer('outage_page', 1, 1_000_000), eventId,
    sort: scalar('sort') ?? 'name', order: scalar('order') === 'desc' ? 'desc' : 'asc' };
}

/** All projections use the same captured clock, including gaps after a worker restart. */
function sources(dashboardId: string, filters: HistoryFilters, pageIds?: string[], filterState = true): Prisma.Sql {
  const serviceFilter = filters.serviceIds.length ? Prisma.sql`AND s.id IN (${Prisma.join(filters.serviceIds.map(id => Prisma.sql`${id}::uuid`))})` : Prisma.empty;
  const pageFilter = pageIds ? pageIds.length ? Prisma.sql`AND s.id IN (${Prisma.join(pageIds.map(id => Prisma.sql`${id}::uuid`))})` : Prisma.sql`AND false` : Prisma.empty;
  return Prisma.sql`WITH service_states AS (
    SELECT s.id, s.name, s.host, greatest(s."historyStartedAt",d."historyStartedAt") AS "historyStartedAt", s."availabilityPrunedBefore", s."checkedAt", d."hourlyRetentionDays", d."dailyRetentionDays",
      CASE WHEN NOT d."monitoringEnabled" THEN 'paused'
        WHEN NOT (coalesce(s.http,false) OR coalesce(s.https,false)) THEN 'unknown'
        WHEN latest.state IN ('up','degraded','down') AND latest."lastObservedAt" + latest."checkIntervalSeconds" * interval '3 seconds' <= ${filters.now} THEN 'unknown'
        ELSE coalesce(latest.state,'unknown') END AS current_state
    FROM "Service" s JOIN "Dashboard" d ON d.id=s."dashboardId"
    LEFT JOIN LATERAL (SELECT state,"lastObservedAt","checkIntervalSeconds" FROM "AvailabilityInterval" WHERE "serviceId"=s.id AND "endedAt" IS NULL LIMIT 1) latest ON true
    WHERE s."dashboardId"=${dashboardId}::uuid ${serviceFilter} ${pageFilter}
  ), selected AS (SELECT * FROM service_states ${filterState && filters.state ? Prisma.sql`WHERE current_state=${filters.state}` : Prisma.empty}),
  projected AS (
    SELECT i.id::text, i."serviceId" AS service_id, i."configurationId" AS configuration_id,
      greatest(i."startedAt",s."historyStartedAt",s."availabilityPrunedBefore") AS started_at, i."startedAt" AS event_at,
      least(coalesce(i."endedAt",${filters.to}), CASE WHEN i."endedAt" IS NULL AND i.state IN ('up','degraded','down') AND i."lastObservedAt" IS NOT NULL
        THEN i."lastObservedAt" + i."checkIntervalSeconds" * interval '3 seconds' ELSE ${filters.to} END) AS ended_at,
      i.state, i."lastObservedAt" AS last_observed_at, i."eventKind" AS event_kind, i.reason,
      i."httpState" AS http_state, i."httpsState" AS https_state, i."httpStatus" AS http_status, i."httpsStatus" AS https_status,
      i."httpError" AS http_error, i."httpsError" AS https_error,
      (i."endedAt" IS NULL OR i."endedAt">${filters.to}) AS open
    FROM "AvailabilityInterval" i JOIN selected s ON s.id=i."serviceId"
    WHERE i."startedAt" < ${filters.to} AND (i."endedAt" IS NULL OR i."endedAt">${filters.from})
    UNION ALL
    SELECT i.id::text || ':gap', i."serviceId", i."configurationId", greatest(i."lastObservedAt" + i."checkIntervalSeconds" * interval '3 seconds',s."historyStartedAt",s."availabilityPrunedBefore"), i."lastObservedAt" + i."checkIntervalSeconds" * interval '3 seconds', ${filters.to},
      'unknown',i."lastObservedAt",'gap','No accepted observation arrived within three check intervals.',null,null,null,null,null,null,true
    FROM "AvailabilityInterval" i JOIN selected s ON s.id=i."serviceId"
    WHERE i."endedAt" IS NULL AND i.state IN ('up','degraded','down') AND i."lastObservedAt" + i."checkIntervalSeconds" * interval '3 seconds' < ${filters.to}
  ), effective AS (SELECT * FROM projected WHERE ended_at>started_at AND ended_at>${filters.from}),
  ordered AS (SELECT *,lag(state) OVER w AS previous_state,lag(ended_at) OVER w AS previous_end,lag(configuration_id) OVER w AS previous_configuration FROM effective WINDOW w AS (PARTITION BY service_id ORDER BY started_at,id)),
  /* Compare actual whole-day counts: settings can be lengthened after rows were pruned.
     Hours are preferred when complete; otherwise retain daily evidence without counting both. */
  performance_days AS (
    SELECT a."serviceId",date_trunc('day',a."bucketStart",'UTC') AS day,
      count(*) FILTER (WHERE a.resolution='hour') AS hour_rows,count(*) FILTER (WHERE a.resolution='day') AS day_rows,
      coalesce(sum(a."httpCount") FILTER (WHERE a.resolution='hour'),0) AS hour_http,
      coalesce(sum(a."httpsCount") FILTER (WHERE a.resolution='hour'),0) AS hour_https,
      coalesce(sum(a."httpCount") FILTER (WHERE a.resolution='day'),0) AS day_http,
      coalesce(sum(a."httpsCount") FILTER (WHERE a.resolution='day'),0) AS day_https
    FROM "PerformanceAggregate" a JOIN selected s ON s.id=a."serviceId"
    WHERE a."bucketStart">=date_trunc('day',${filters.from}::timestamptz,'UTC')
      AND a."bucketStart"<date_trunc('day',${filters.to}::timestamptz,'UTC')+interval '24 hours'
    GROUP BY a."serviceId",date_trunc('day',a."bucketStart",'UTC')
  ), retained_performance AS (
    SELECT a.* FROM "PerformanceAggregate" a JOIN performance_days p ON p."serviceId"=a."serviceId" AND p.day=date_trunc('day',a."bucketStart",'UTC')
    WHERE a."bucketStart"<${filters.to}
      AND a."bucketStart"+CASE a.resolution WHEN 'hour' THEN interval '1 hour' ELSE interval '24 hours' END>${filters.from}
      AND ((a.resolution='hour' AND p.hour_rows>0 AND (p.day_rows=0 OR (p.hour_http>=p.day_http AND p.hour_https>=p.day_https)))
        OR (a.resolution='day' AND (p.hour_rows=0 OR p.hour_http<p.day_http OR p.hour_https<p.day_https)))
  )`;
}

export function statistics(input: Partial<Record<'up_ms' | 'degraded_ms' | 'down_ms' | 'unknown_ms' | 'paused_ms' | 'total_ms' | 'outage_count', number | string | bigint | null>>): AvailabilityStatistics {
  const number = (key: keyof typeof input) => Number(input[key] ?? 0);
  const up = number('up_ms'), degraded = number('degraded_ms'), down = number('down_ms'), total = number('total_ms');
  const known = up + degraded + down;
  return { up_ms: up, degraded_ms: degraded, down_ms: down, unknown_ms: number('unknown_ms'), paused_ms: number('paused_ms'),
    known_ms: known, total_ms: total, outage_count: number('outage_count'), uptime_percent: known ? 100 * up / known : null,
    coverage_percent: total ? 100 * known / total : 0 };
}
function pagination(total: number, filters: HistoryFilters): HistoryPagination {
  return { page: filters.page, limit: filters.limit, total, total_pages: Math.ceil(total / filters.limit) };
}
const emptyPerformance = (): ProtocolPerformance => ({ count: 0, failures: 0, response_count: 0, average_ms: null, min_ms: null, max_ms: null });
function protocol(row: Record<string, unknown>, prefix: 'http' | 'https'): ProtocolPerformance {
  const count = Number(row[`${prefix}_count`] ?? 0), response = Number(row[`${prefix}_response_count`] ?? 0);
  return { count, failures: Number(row[`${prefix}_failures`] ?? 0), response_count: response,
    average_ms: response ? Number(row[`${prefix}_duration_sum`] ?? 0) / response : null,
    min_ms: row[`${prefix}_duration_min`] == null ? null : Number(row[`${prefix}_duration_min`]), max_ms: row[`${prefix}_duration_max`] == null ? null : Number(row[`${prefix}_duration_max`]) };
}

function performanceColumns(group: boolean): Prisma.Sql {
  return Prisma.sql`${group ? Prisma.sql`a."serviceId" AS service_id,` : Prisma.empty}
    sum(a."httpCount") AS http_count,sum(a."httpFailures") AS http_failures,sum(a."httpResponseCount") AS http_response_count,sum(a."httpDurationSum") AS http_duration_sum,min(a."httpDurationMin") AS http_duration_min,max(a."httpDurationMax") AS http_duration_max,
    sum(a."httpsCount") AS https_count,sum(a."httpsFailures") AS https_failures,sum(a."httpsResponseCount") AS https_response_count,sum(a."httpsDurationSum") AS https_duration_sum,min(a."httpsDurationMin") AS https_duration_min,max(a."httpsDurationMax") AS https_duration_max`;
}

export async function dashboardHistory(prisma: HistoryQueryClient, dashboardId: string, filters: HistoryFilters): Promise<HistoryResponse> {
  if (!await prisma.dashboard.findUnique({ where: { id: dashboardId }, select: { id: true } })) notFound();
  const duration = filters.to.getTime() - filters.from.getTime();
  const base = sources(dashboardId, filters);
  const serviceStats = Prisma.sql`SELECT s.*, ${duration}::double precision AS total_ms,
    coalesce(sum(extract(epoch FROM (least(e.ended_at,${filters.to})-greatest(e.started_at,${filters.from})))*1000) FILTER (WHERE e.state='up'),0) AS up_ms,
    coalesce(sum(extract(epoch FROM (least(e.ended_at,${filters.to})-greatest(e.started_at,${filters.from})))*1000) FILTER (WHERE e.state='degraded'),0) AS degraded_ms,
    coalesce(sum(extract(epoch FROM (least(e.ended_at,${filters.to})-greatest(e.started_at,${filters.from})))*1000) FILTER (WHERE e.state='down'),0) AS down_ms,
    coalesce(sum(extract(epoch FROM (least(e.ended_at,${filters.to})-greatest(e.started_at,${filters.from})))*1000) FILTER (WHERE e.state='unknown'),0) AS unknown_ms,
    coalesce(sum(extract(epoch FROM (least(e.ended_at,${filters.to})-greatest(e.started_at,${filters.from})))*1000) FILTER (WHERE e.state='paused'),0) AS paused_ms,
    count(e.id) FILTER (WHERE e.state IN ('down','degraded') AND (e.previous_state IS NULL OR e.previous_state NOT IN ('down','degraded') OR e.previous_end<>e.started_at OR e.previous_configuration IS DISTINCT FROM e.configuration_id)) AS outage_count
    FROM selected s LEFT JOIN ordered e ON e.service_id=s.id GROUP BY s.id,s.name,s.host,s."historyStartedAt",s."availabilityPrunedBefore",s."checkedAt",s."hourlyRetentionDays",s."dailyRetentionDays",s.current_state`;
  const sortColumns: Record<string, string> = { name: 'name', state: 'current_state', current_state: 'current_state', uptime: 'uptime', uptime_percent: 'uptime', downtime: 'downtime', down_ms: 'downtime', outage_count: 'outage_count', latest_check_at: 'checkedAt', response_ms: 'response_ms' };
  const sort = sortColumns[filters.sort] ?? 'name';
  const sortSql = sort === 'response_ms' ? Prisma.sql`(SELECT sum(a."httpDurationSum"+a."httpsDurationSum")/nullif(sum(a."httpResponseCount"+a."httpsResponseCount"),0) FROM retained_performance a WHERE a."serviceId"=stats.id)` : sort === 'uptime' ? Prisma.sql`up_ms/nullif(up_ms+degraded_ms+down_ms,0)` : sort === 'downtime' ? Prisma.sql`down_ms+degraded_ms` : Prisma.raw(`"${sort}"`);
  const [rows, totals] = await Promise.all([
    prisma.$queryRaw<Record<string, unknown>[]>(Prisma.sql`${base}, stats AS (${serviceStats}) SELECT * FROM stats ORDER BY ${sortSql} ${Prisma.raw(filters.order)} NULLS LAST,id LIMIT ${filters.limit} OFFSET ${(filters.page - 1) * filters.limit}`),
    prisma.$queryRaw<Record<string, unknown>[]>(Prisma.sql`${base}, stats AS (${serviceStats}) SELECT count(*) AS total,count(*) FILTER(WHERE current_state='up') AS count_up,count(*) FILTER(WHERE current_state='degraded') AS count_degraded,count(*) FILTER(WHERE current_state='down') AS count_down,count(*) FILTER(WHERE current_state='unknown') AS count_unknown,count(*) FILTER(WHERE current_state='paused') AS count_paused,sum(total_ms) AS total_ms,sum(up_ms) AS up_ms,sum(degraded_ms) AS degraded_ms,sum(down_ms) AS down_ms,sum(unknown_ms) AS unknown_ms,sum(paused_ms) AS paused_ms,sum(outage_count) AS outage_count FROM stats`),
  ]);
  const ids = rows.map(row => String(row.id));
  const timeline = new Map<string, TimelineBucket[]>();
  const perf = new Map<string, { http: ProtocolPerformance; https: ProtocolPerformance }>();
  if (ids.length) {
    const page = sources(dashboardId, filters, ids);
    const bucketCount = Math.min(240, Math.max(1, Math.ceil(duration / 60_000)));
    const [buckets, performance] = await Promise.all([
      prisma.$queryRaw<Record<string, unknown>[]>(Prisma.sql`${page}, buckets AS (SELECT s.id, n,${filters.from}::timestamptz + (${duration}::double precision*n/${bucketCount})*interval '1 millisecond' AS start,
        ${filters.from}::timestamptz + (${duration}::double precision*(n+1)/${bucketCount})*interval '1 millisecond' AS finish,s."historyStartedAt",s."availabilityPrunedBefore" FROM selected s CROSS JOIN generate_series(0,${bucketCount - 1}) n)
        SELECT b.id,b.n,b.start,b.finish,array_remove(array_agg(DISTINCT e.state),null) ||
        CASE WHEN b.start<b."historyStartedAt" THEN ARRAY['not_monitored'] ELSE ARRAY[]::text[] END ||
        CASE WHEN b."availabilityPrunedBefore" IS NOT NULL AND b.start<b."availabilityPrunedBefore" AND b.finish>b."historyStartedAt" THEN ARRAY['not_retained'] ELSE ARRAY[]::text[] END AS states
        FROM buckets b LEFT JOIN effective e ON e.service_id=b.id AND e.started_at<b.finish AND e.ended_at>b.start GROUP BY b.id,b.n,b.start,b.finish,b."historyStartedAt",b."availabilityPrunedBefore" ORDER BY b.id,b.n`),
      prisma.$queryRaw<Record<string, unknown>[]>(Prisma.sql`${page} SELECT ${performanceColumns(true)} FROM retained_performance a GROUP BY a."serviceId"`),
    ]);
    const priority = ['down','degraded','unknown','paused','up','not_retained','not_monitored'];
    for (const row of buckets) {
      const observed = row.states as string[];
      const state = priority.find(item => observed.includes(item)) ?? 'unknown';
      const list = timeline.get(String(row.id)) ?? [];
      list.push({ from: (row.start as Date).toISOString(), to: (row.finish as Date).toISOString(), state: state as TimelineBucket['state'], states: (observed.length ? observed : ['unknown']) as TimelineBucket['states'] });
      timeline.set(String(row.id), list);
    }
    for (const row of performance) perf.set(String(row.service_id), { http: protocol(row, 'http'), https: protocol(row, 'https') });
  }
  const services: HistoryServiceSummary[] = rows.map(row => ({ service_id: String(row.id), name: String(row.name), host: String(row.host), current_state: row.current_state as HistoryServiceSummary['current_state'],
    latest_check_at: row.checkedAt instanceof Date ? row.checkedAt.toISOString() : null, statistics: statistics(row), timeline: timeline.get(String(row.id)) ?? [],
    performance: perf.get(String(row.id)) ?? { http: emptyPerformance(), https: emptyPerformance() }, history_started_at: (row.historyStartedAt as Date).toISOString(),
    availability_pruned_before: row.availabilityPrunedBefore instanceof Date ? row.availabilityPrunedBefore.toISOString() : null }));
  const total = totals[0] ?? {};
  return { from: filters.from.toISOString(), to: filters.to.toISOString(), generated_at: filters.now.toISOString(), services, summary: statistics(total), current_counts: {up:Number(total.count_up??0),degraded:Number(total.count_degraded??0),down:Number(total.count_down??0),unknown:Number(total.count_unknown??0),paused:Number(total.count_paused??0)}, pagination: pagination(Number(total.total ?? 0), filters) };
}

export async function dashboardEvents(prisma: HistoryQueryClient, dashboardId: string, filters: HistoryFilters): Promise<EventsResponse> {
  if (!await prisma.dashboard.findUnique({ where: { id: dashboardId }, select: { id: true } })) notFound();
  const base = sources(dashboardId, filters, undefined, false);
  const eventWhere = Prisma.sql`e.event_at>=${filters.from} AND e.event_at<${filters.to} ${filters.state ? Prisma.sql`AND e.state=${filters.state}` : Prisma.empty}`;
  const [rows, count] = await Promise.all([
    prisma.$queryRaw<Record<string, unknown>[]>(Prisma.sql`${base} SELECT e.*,s.name AS service_name,
      (SELECT i.state FROM "AvailabilityInterval" i WHERE i."serviceId"=e.service_id AND i."startedAt"<e.event_at ORDER BY i."startedAt" DESC LIMIT 1) AS preceding
      FROM effective e JOIN selected s ON s.id=e.service_id WHERE ${eventWhere} ORDER BY e.event_at DESC,e.id DESC LIMIT ${filters.limit} OFFSET ${(filters.page-1)*filters.limit}`),
    prisma.$queryRaw<{ total: bigint }[]>(Prisma.sql`${base} SELECT count(*) AS total FROM effective e WHERE ${eventWhere}`),
  ]);
  return { from: filters.from.toISOString(), to: filters.to.toISOString(), generated_at: filters.now.toISOString(), events: rows.map(row => ({ id: String(row.id), service_id: String(row.service_id), service_name: String(row.service_name), at: (row.event_at as Date).toISOString(), state: row.state as EventsResponse['events'][number]['state'], previous_state: row.preceding as EventsResponse['events'][number]['previous_state'], kind: String(row.event_kind), reason: row.reason as string | null, configuration_id: String(row.configuration_id) })), pagination: pagination(Number(count[0]?.total ?? 0), filters) };
}

export async function serviceHistory(prisma: HistoryQueryClient, dashboardId: string, serviceId: string, filters: HistoryFilters): Promise<ServiceHistoryResponse> {
  const own = { ...filters, serviceIds: [serviceId], state: undefined };
  const summary = await dashboardHistory(prisma, dashboardId, { ...own, page: 1 });
  const service = summary.services[0];
  if (!service) notFound();
  const base = sources(dashboardId, own);
  const outageBase = sources(dashboardId,{...own,from:new Date(service.availability_pruned_before ?? service.history_started_at)});
  // A gap can first be projected by a reader and later materialized by a worker.
  // Resolve its original :gap link to that same boundary after materialization.
  const gapAlias = filters.eventId?.endsWith(':gap') ? Prisma.sql`OR (e.event_kind='gap' AND EXISTS (
    SELECT 1 FROM "AvailabilityInterval" previous WHERE previous.id=${filters.eventId.slice(0,-4)}::uuid
      AND previous."serviceId"=e.service_id AND previous."configurationId"=e.configuration_id
      AND e.event_at=previous."lastObservedAt"+previous."checkIntervalSeconds"*interval '3 seconds'))` : Prisma.empty;
  const eventFilter = filters.eventId ? Prisma.sql`WHERE (e.id=${filters.eventId} ${gapAlias}) AND e.event_at>=${filters.from} AND e.event_at<${filters.to}` : Prisma.empty;
  const intervalPage = filters.eventId ? 1 : filters.page;
  const outagePage = filters.outagePage ?? 1;
  const outagesQuery = Prisma.sql`${outageBase}, marked AS (SELECT *,sum(CASE WHEN state NOT IN ('down','degraded') OR previous_state IS NULL OR previous_state NOT IN ('down','degraded') OR previous_end<>started_at OR previous_configuration IS DISTINCT FROM configuration_id THEN 1 ELSE 0 END) OVER (ORDER BY started_at,id) AS island FROM ordered), outages AS (SELECT min(started_at) AS start,max(ended_at) AS finish,bool_or(open) AS ongoing,array_agg(configuration_id ORDER BY started_at DESC) AS configs FROM marked WHERE state IN ('down','degraded') GROUP BY island)`;
  const [intervalRows, counts, aggregateRows, outageRows, outageCounts] = await Promise.all([
    prisma.$queryRaw<Record<string, unknown>[]>(Prisma.sql`${base} SELECT e.*,c.revision,c.host,c.port,c.http,c.https,c."httpPath",c."httpXquery",
      ${filters.eventId ? Prisma.sql`(SELECT i.state FROM "AvailabilityInterval" i WHERE i."serviceId"=e.service_id AND i."startedAt"<e.event_at ORDER BY i."startedAt" DESC LIMIT 1)` : Prisma.sql`null::text`} AS preceding
      FROM effective e LEFT JOIN "ServiceConfiguration" c ON c.id=e.configuration_id ${eventFilter} ORDER BY e.started_at DESC,e.id DESC LIMIT ${filters.limit} OFFSET ${(intervalPage-1)*filters.limit}`),
    prisma.$queryRaw<{ total: bigint }[]>(Prisma.sql`${base} SELECT count(*) AS total FROM effective e ${eventFilter}`),
    // Charts remain bounded even for indefinite retention: adjacent buckets are combined into at most 240 points per resolution.
    prisma.$queryRaw<Record<string, unknown>[]>(Prisma.sql`${base}, data AS (SELECT a.*,greatest(0,least(239,floor(extract(epoch FROM (a."bucketStart"-${filters.from}::timestamptz))*1000 / ${Math.max(1,(filters.to.getTime()-filters.from.getTime())/240)}))) AS chart_bucket FROM retained_performance a)
      SELECT min(a."bucketStart") AS start,max(a."bucketStart" + CASE a.resolution WHEN 'hour' THEN interval '1 hour' ELSE interval '1 day' END) AS finish,array_agg(DISTINCT a.resolution) AS resolutions,${performanceColumns(false)} FROM data a GROUP BY chart_bucket ORDER BY chart_bucket`),
    prisma.$queryRaw<Record<string, unknown>[]>(Prisma.sql`${outagesQuery}
      SELECT o.*,(SELECT CASE WHEN n.configuration_id IS DISTINCT FROM o.configs[1] THEN 'target_changed' WHEN n.state IN ('unknown','paused') THEN n.state ELSE null END FROM effective n WHERE n.started_at>=o.finish ORDER BY n.started_at LIMIT 1) AS interrupted FROM outages o WHERE o.finish>${filters.from} ORDER BY start DESC LIMIT ${filters.limit} OFFSET ${(outagePage-1)*filters.limit}`),
    prisma.$queryRaw<{ total: bigint }[]>(Prisma.sql`${outagesQuery} SELECT count(*) AS total FROM outages WHERE finish>${filters.from}`),
  ]);
  const intervals: HistoryInterval[] = intervalRows.map(row => ({ id: String(row.id), from: (row.started_at as Date).toISOString(), to: (row.ended_at as Date).toISOString(), last_observed_at: row.last_observed_at instanceof Date ? row.last_observed_at.toISOString() : null, state: row.state as HistoryInterval['state'], http_state: row.http_state as HistoryInterval['http_state'], https_state: row.https_state as HistoryInterval['https_state'], reason: row.reason as string | null, http_status: row.http_status as number | null, https_status: row.https_status as number | null, http_error: row.http_error as string | null, https_error: row.https_error as string | null, event_kind: String(row.event_kind), configuration: { id: String(row.configuration_id), revision: Number(row.revision), host: String(row.host), port: Number(row.port), http: Boolean(row.http), https: Boolean(row.https), http_path: String(row.httpPath), http_xquery: row.httpXquery as string | null } }));
  const resolutions = new Set(aggregateRows.flatMap(row => row.resolutions as string[]));
  const performance_buckets: HistoryPerformanceBucket[] = aggregateRows.map(row => ({ from: (row.start as Date).toISOString(), to: (row.finish as Date).toISOString(), http: protocol(row,'http'), https: protocol(row,'https') }));
  const outages: HistoryOutage[] = outageRows.map(row => ({ from: (row.start as Date).toISOString(), to: (row.finish as Date).toISOString(), ongoing: Boolean(row.ongoing) && (row.finish as Date)>=filters.to, interrupted_by: row.interrupted as HistoryOutage['interrupted_by'] }));
  const selected = filters.eventId ? intervalRows[0] : undefined;
  const selected_event: ServiceHistoryResponse['selected_event'] = selected ? {
    id: String(selected.id), service_id: serviceId, service_name: service.name, at: (selected.event_at as Date).toISOString(),
    state: selected.state as HistoryInterval['state'], previous_state: selected.preceding as HistoryInterval['state'] | null,
    kind: String(selected.event_kind), reason: selected.reason as string | null, configuration_id: String(selected.configuration_id),
  } : null;
  return { ...service, from: summary.from, to: summary.to, generated_at: summary.generated_at, intervals, performance_resolution: resolutions.size>1 ? 'mixed' : resolutions.has('day') ? 'day' : 'hour', performance_buckets, outages, selected_event,
    pagination: pagination(Number(counts[0]?.total??0),{...filters,page:intervalPage}),
    outage_pagination: pagination(Number(outageCounts[0]?.total??0),{...filters,page:outagePage}) };
}
