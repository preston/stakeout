import type { Prisma } from '@prisma/client';
import type { Pool, QueryResultRow } from 'pg';
import type { AvailabilityState } from '@stakeout/core';

export interface HistoryDatabase {
  query<R extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** Lets API mutations and worker completions share the same transactional writer. */
export function prismaHistoryDatabase(transaction: Prisma.TransactionClient): HistoryDatabase {
  return {
    async query<R extends QueryResultRow>(sql: string, values: unknown[] = []) {
      const rows = await transaction.$queryRawUnsafe<R[]>(sql, ...values);
      return { rows, rowCount: rows.length };
    },
  };
}

export interface ProtocolObservation {
  up: boolean;
  status: number | null;
  error: string | null;
  durationMs: number | null;
}

export interface AvailabilityObservation {
  http: ProtocolObservation | null;
  https: ProtocolObservation | null;
}

interface HistoryService extends QueryResultRow {
  id: string;
  configRevision: number;
  host: string;
  port: number;
  http: boolean | null;
  https: boolean | null;
  httpPath: string;
  httpXquery: string | null;
  historyStartedAt: Date;
  dashboardHistoryStartedAt: Date;
  monitoringEnabled: boolean;
  checkIntervalSeconds: number;
}

interface Interval extends QueryResultRow {
  id: string;
  configurationId: string;
  state: AvailabilityState;
  httpState: string | null;
  httpsState: string | null;
  startedAt: Date;
  lastObservedAt: Date | null;
  checkIntervalSeconds: number;
  reason: string | null;
}

const known = (state: string) => ['up', 'degraded', 'down'].includes(state);

async function serviceFor(db: HistoryDatabase, serviceId: string): Promise<HistoryService | undefined> {
  const result = await db.query<HistoryService>(`SELECT s.id,s."configRevision",s.host,s.port,s.http,s.https,
    s."httpPath",s."httpXquery",s."historyStartedAt",d."historyStartedAt" AS "dashboardHistoryStartedAt",
    d."monitoringEnabled",d."checkIntervalSeconds"
    FROM "Service" s JOIN "Dashboard" d ON d.id=s."dashboardId" WHERE s.id=$1`, [serviceId]);
  return result.rows[0];
}

async function configurationFor(db: HistoryDatabase, service: HistoryService, at: Date): Promise<string> {
  const existing = (await db.query<{ id: string }>(`SELECT id FROM "ServiceConfiguration"
    WHERE "serviceId"=$1 AND revision=$2`, [service.id,service.configRevision])).rows[0];
  if (existing) return existing.id;
  const result = await db.query<{ id: string }>(`INSERT INTO "ServiceConfiguration"
    ("serviceId",revision,"createdAt",host,port,http,https,"httpPath","httpXquery")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT ("serviceId",revision) DO NOTHING RETURNING id`,
  [service.id,service.configRevision,at,service.host,service.port,!!service.http,!!service.https,service.httpPath,service.httpXquery]);
  return result.rows[0]?.id ?? (await db.query<{ id: string }>(`SELECT id FROM "ServiceConfiguration"
    WHERE "serviceId"=$1 AND revision=$2`, [service.id,service.configRevision])).rows[0]!.id;
}

async function insertInterval(db: HistoryDatabase, service: HistoryService, configurationId: string, at: Date,
  state: AvailabilityState, reason: string | null, eventKind: string, observation?: AvailabilityObservation): Promise<Interval> {
  const result = await db.query<Interval>(`INSERT INTO "AvailabilityInterval"
    ("serviceId","configurationId","startedAt",state,reason,"eventKind","checkIntervalSeconds",
     "httpState","httpsState","httpStatus","httpsStatus","httpError","httpsError","lastObservedAt")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
  [service.id,configurationId,at,state,reason,eventKind,service.checkIntervalSeconds,
    observation?.http ? observation.http.up ? 'up' : 'down' : null,
    observation?.https ? observation.https.up ? 'up' : 'down' : null,
    observation?.http?.status ?? null,observation?.https?.status ?? null,
    observation?.http?.error?.slice(0,500) ?? null,observation?.https?.error?.slice(0,500) ?? null,
    observation ? at : null]);
  return result.rows[0]!;
}

async function transition(db: HistoryDatabase, service: HistoryService, current: Interval, configurationId: string,
  at: Date, state: AvailabilityState, reason: string | null, kind: string, observation?: AvailabilityObservation): Promise<Interval> {
  // A process clock moving backwards cannot produce overlapping intervals.
  const boundary = new Date(Math.max(at.getTime(), current.startedAt.getTime()));
  await db.query(`UPDATE "AvailabilityInterval" SET "endedAt"=$2 WHERE id=$1 RETURNING id`, [current.id,boundary]);
  return insertInterval(db,service,configurationId,boundary,state,reason,kind,observation);
}

/** Caller locks Dashboard → Service, before locking jobs or history rows. */
export async function reconcileServiceHistory(db: HistoryDatabase, serviceId: string, at = new Date()): Promise<Interval | null> {
  const service = await serviceFor(db,serviceId);
  if (!service) return null;
  const configurationId = await configurationFor(db,service,at);
  let current = (await db.query<Interval>(`SELECT * FROM "AvailabilityInterval"
    WHERE "serviceId"=$1 AND "endedAt" IS NULL FOR UPDATE`, [service.id])).rows[0];
  if (!current) {
    const start = new Date(Math.max(service.historyStartedAt.getTime(),service.dashboardHistoryStartedAt.getTime()));
    const state = service.monitoringEnabled ? 'unknown' : 'paused';
    const reason = !service.monitoringEnabled ? 'dashboard_paused' : !service.http && !service.https ? 'unconfigured' : 'awaiting_check';
    current = await insertInterval(db,service,configurationId,start,state,reason,'monitoring_started');
  }
  // Gap detection uses the cadence actually attached to the last observation.
  if (known(current.state) && current.lastObservedAt) {
    const expires = new Date(current.lastObservedAt.getTime() + current.checkIntervalSeconds * 3000);
    if (at.getTime() > expires.getTime()) {
      current = await transition(db,service,current,current.configurationId,expires,'unknown','monitoring_gap','gap');
    }
  }
  const configured = !!service.http || !!service.https;
  const state = !service.monitoringEnabled ? 'paused' : 'unknown';
  const reason = !service.monitoringEnabled ? 'dashboard_paused' : !configured ? 'unconfigured' : 'awaiting_check';
  if (current.configurationId !== configurationId) {
    current = await transition(db,service,current,configurationId,at,state,reason,'target_changed');
  } else if (!service.monitoringEnabled && current.state !== 'paused') {
    current = await transition(db,service,current,configurationId,at,'paused',reason,'paused');
  } else if (service.monitoringEnabled && current.state === 'paused') {
    current = await transition(db,service,current,configurationId,at,'unknown',reason,'resumed');
  } else if (service.monitoringEnabled && !configured && current.reason !== 'unconfigured') {
    current = await transition(db,service,current,configurationId,at,'unknown','unconfigured','unconfigured');
  }
  return current;
}

/** Writes accepted observations only, inside the transaction owning the job lease. */
export async function recordAvailabilityObservation(db: HistoryDatabase, serviceId: string,
  observation: AvailabilityObservation, at = new Date()): Promise<void> {
  const service = await serviceFor(db,serviceId);
  if (!service?.monitoringEnabled || (!service.http && !service.https)) return;
  const current = await reconcileServiceHistory(db,serviceId,at);
  if (!current) return;
  if (at.getTime() < current.startedAt.getTime()) return;
  // Defensive idempotency complements job ownership: never count one observation twice.
  if (current.lastObservedAt && current.lastObservedAt.getTime() >= at.getTime()) return;
  const http = service.http ? observation.http : null;
  const https = service.https ? observation.https : null;
  if ((service.http && !http) || (service.https && !https)) throw new Error('Enabled protocols require complete observations');
  const checks = [http,https].filter((value): value is ProtocolObservation => value !== null);
  const successes = checks.filter(check => check.up).length;
  const state: AvailabilityState = successes === checks.length ? 'up' : successes === 0 ? 'down' : 'degraded';
  const httpState = http ? http.up ? 'up' : 'down' : null;
  const httpsState = https ? https.up ? 'up' : 'down' : null;
  const accepted = { http,https };
  if (current.state !== state || current.httpState !== httpState || current.httpsState !== httpsState) {
    await transition(db,service,current,current.configurationId,at,state,null,
      state === 'up' ? 'recovery' : state === 'down' ? 'down' : 'degraded',accepted);
  } else {
    await db.query(`UPDATE "AvailabilityInterval" SET "lastObservedAt"=$2,"httpStatus"=$3,"httpsStatus"=$4,
      "httpError"=$5,"httpsError"=$6,"checkIntervalSeconds"=$7 WHERE id=$1 RETURNING id`,
    [current.id,at,http?.status ?? null,https?.status ?? null,http?.error?.slice(0,500) ?? null,
      https?.error?.slice(0,500) ?? null,service.checkIntervalSeconds]);
  }
  for (const resolution of ['hour','day']) {
    const bucket = new Date(at);
    if (resolution === 'day') bucket.setUTCHours(0,0,0,0);
    else bucket.setUTCMinutes(0,0,0);
    const values = (check: ProtocolObservation | null) => [check ? 1 : 0,check && !check.up ? 1 : 0,
      check?.durationMs != null && check.status != null ? 1 : 0,
      check?.status != null ? check.durationMs ?? 0 : 0,
      check?.status != null ? check.durationMs : null];
    await db.query(`INSERT INTO "PerformanceAggregate" ("serviceId",resolution,"bucketStart",
      "httpCount","httpFailures","httpResponseCount","httpDurationSum","httpDurationMin","httpDurationMax",
      "httpsCount","httpsFailures","httpsResponseCount","httpsDurationSum","httpsDurationMin","httpsDurationMax")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12,$13,$13)
      ON CONFLICT ("serviceId",resolution,"bucketStart") DO UPDATE SET
      "httpCount"="PerformanceAggregate"."httpCount"+EXCLUDED."httpCount",
      "httpFailures"="PerformanceAggregate"."httpFailures"+EXCLUDED."httpFailures",
      "httpResponseCount"="PerformanceAggregate"."httpResponseCount"+EXCLUDED."httpResponseCount",
      "httpDurationSum"="PerformanceAggregate"."httpDurationSum"+EXCLUDED."httpDurationSum",
      "httpDurationMin"=LEAST("PerformanceAggregate"."httpDurationMin",EXCLUDED."httpDurationMin"),
      "httpDurationMax"=GREATEST("PerformanceAggregate"."httpDurationMax",EXCLUDED."httpDurationMax"),
      "httpsCount"="PerformanceAggregate"."httpsCount"+EXCLUDED."httpsCount",
      "httpsFailures"="PerformanceAggregate"."httpsFailures"+EXCLUDED."httpsFailures",
      "httpsResponseCount"="PerformanceAggregate"."httpsResponseCount"+EXCLUDED."httpsResponseCount",
      "httpsDurationSum"="PerformanceAggregate"."httpsDurationSum"+EXCLUDED."httpsDurationSum",
      "httpsDurationMin"=LEAST("PerformanceAggregate"."httpsDurationMin",EXCLUDED."httpsDurationMin"),
      "httpsDurationMax"=GREATEST("PerformanceAggregate"."httpsDurationMax",EXCLUDED."httpsDurationMax") RETURNING "serviceId"`,
    [serviceId,resolution,bucket,...values(http),...values(https)]);
  }
}

/** A bounded, restart-safe maintenance pass. A session-wide lock avoids duplicate pruning. */
export async function pruneHistory(pool: Pool, batchSize = 1000): Promise<number> {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) throw new Error('History prune batch size must be positive');
  const client = await pool.connect();
  let deleted = 0;
  try {
    await client.query('BEGIN');
    const locked = (await client.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock(684561113020261020) AS locked')).rows[0]!.locked;
    if (!locked) { await client.query('ROLLBACK'); return 0; }
    // Take service locks before dependent history locks, matching completions.
    // SKIP LOCKED lets live checks and administration proceed during pruning.
    await client.query(`WITH candidates AS (
      SELECT s.id,now()-d."availabilityRetentionDays"*interval '1 day' AS cutoff
      FROM "Service" s JOIN "Dashboard" d ON d.id=s."dashboardId"
      WHERE d."availabilityRetentionDays" IS NOT NULL
      AND (s."availabilityPrunedBefore" IS NULL OR s."availabilityPrunedBefore" < now()-d."availabilityRetentionDays"*interval '1 day')
      ORDER BY s."availabilityPrunedBefore"+d."availabilityRetentionDays"*interval '1 day' ASC NULLS FIRST,s.id
      LIMIT $1 FOR UPDATE OF s SKIP LOCKED)
      UPDATE "Service" s SET "availabilityPrunedBefore"=c.cutoff FROM candidates c WHERE s.id=c.id`, [batchSize]);
    const intervals = await client.query(`DELETE FROM "AvailabilityInterval" WHERE id IN (
      SELECT i.id FROM "AvailabilityInterval" i JOIN "Service" s ON s.id=i."serviceId"
      WHERE i."endedAt" IS NOT NULL AND i."endedAt" <= s."availabilityPrunedBefore"
      ORDER BY i."endedAt" LIMIT $1 FOR UPDATE OF i SKIP LOCKED)`, [batchSize]);
    deleted += intervals.rowCount ?? 0;
    const aggregates = await client.query(`DELETE FROM "PerformanceAggregate" a WHERE
      (a."serviceId",a.resolution,a."bucketStart") IN (
        SELECT p."serviceId",p.resolution,p."bucketStart" FROM "PerformanceAggregate" p
        JOIN "Service" s ON s.id=p."serviceId" JOIN "Dashboard" d ON d.id=s."dashboardId"
        WHERE (p.resolution='hour' AND d."hourlyRetentionDays" IS NOT NULL
          AND p."bucketStart" + interval '1 hour' <= now()-d."hourlyRetentionDays"*interval '1 day')
        OR (p.resolution='day' AND d."dailyRetentionDays" IS NOT NULL
          AND p."bucketStart" + interval '1 day' <= now()-d."dailyRetentionDays"*interval '1 day')
        ORDER BY p."bucketStart" LIMIT $1 FOR UPDATE OF p SKIP LOCKED
      )`, [batchSize]);
    deleted += aggregates.rowCount ?? 0;
    const configurations = await client.query(`DELETE FROM "ServiceConfiguration" WHERE id IN (
      SELECT c.id FROM "ServiceConfiguration" c JOIN "Service" s ON s.id=c."serviceId"
      WHERE c.revision<>s."configRevision" AND c."createdAt"<=s."availabilityPrunedBefore"
      AND NOT EXISTS (SELECT 1 FROM "AvailabilityInterval" i WHERE i."configurationId"=c.id)
      ORDER BY c."createdAt" LIMIT $1 FOR UPDATE OF c SKIP LOCKED)`, [batchSize]);
    deleted += configurations.rowCount ?? 0;
    await client.query('COMMIT');
    return deleted;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
