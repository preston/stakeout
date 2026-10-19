import http from 'node:http';
import https from 'node:https';
import { serviceTargetUrl } from '@stakeout/core';
import { jobDatabase, withOwnedJob, type ServiceCheckJob } from './queue.ts';
import { recordAvailabilityObservation } from '../history/recording.ts';
import { createScreenshotPreview, screenshotHash } from '../screenshots.ts';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const JOB_TIMEOUT_MS = 60_000;
export const CONNECT_TIMEOUT_MS = 5_000;
export const READ_TIMEOUT_MS = 10_000;
export const SCREENSHOT_TIMEOUT_MS = 15_000;

export interface CheckConfiguration {
  chromeUrl?: string;
  chromeToken?: string;
}

export interface ServiceSnapshot {
  id: string;
  dashboardId: string | null;
  host: string;
  port: number;
  http: boolean | null;
  https: boolean | null;
  httpPath: string;
  httpPathLast: boolean | null;
  httpsPathLast: boolean | null;
  httpPreview: boolean | null;
  configRevision: number;
  monitoringRevision: number;
  monitoringEnabled: boolean;
  screenshotsEnabled: boolean;
  checkIntervalSeconds: number;
  screenshotIntervalSeconds: number;
  screenshotDemandUntil: Date | null;
  checkedAt: Date | null;
  screenshotCheckedAt: Date | null;
  availabilityCheckRequestedAt: Date | null;
}

interface HttpResponse {
  status: number;
  body: Buffer;
}

/** Core HTTP deliberately does not follow redirects, matching Net::HTTP. */
function request(
  url: URL,
  options: { signal: AbortSignal; method?: string; body?: string; readTimeoutMs?: number; collectBody?: boolean },
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    let connected = false;
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method: options.method ?? 'GET',
      agent: false,
      signal: options.signal,
      ...(options.body ? { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' } } : {}),
    });
    const connectTimer = setTimeout(() => req.destroy(new Error('Connection timed out')), CONNECT_TIMEOUT_MS);
    const fail = (error: Error) => {
      clearTimeout(connectTimer);
      reject(error);
    };
    req.once('error', fail);
    req.once('socket', (socket) => {
      const ready = () => {
        connected = true;
        clearTimeout(connectTimer);
        req.setTimeout(options.readTimeoutMs ?? READ_TIMEOUT_MS, () => req.destroy(new Error('Read timed out')));
      };
      if (!socket.connecting && url.protocol === 'http:') ready();
      else socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', ready);
    });
    req.once('response', (response) => {
      if (!connected) clearTimeout(connectTimer);
      if (!options.collectBody) {
        // Availability depends on the HTTP status, including streaming endpoints.
        // Stop reading immediately so an endless body cannot consume a worker.
        clearTimeout(connectTimer);
        resolve({ status: response.statusCode ?? 0, body: Buffer.alloc(0) });
        response.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      response.on('data', (chunk: Buffer) => {
        if (!options.collectBody) return;
        length += chunk.length;
        if (length > 32 * 1024 * 1024) {
          response.destroy(new Error('Screenshot exceeds 32 MB'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('error', fail);
      response.once('aborted', () => fail(new Error('Response was interrupted')));
      response.once('end', () => {
        clearTimeout(connectTimer);
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) });
      });
    });
    req.end(options.body);
  });
}

export function serviceUrl(service: Pick<ServiceSnapshot, 'host' | 'port' | 'httpPath'>, secure: boolean): URL {
  return new URL(serviceTargetUrl({ ...service, http_path: service.httpPath }, secure));
}

export function browserlessScreenshotUrl(chromeUrl: string, token?: string): URL {
  const input = chromeUrl.trim().replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:');
  const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `http://${input}`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Browserless URL must use HTTP(S) or WS(S)');
  if (!url.pathname.replace(/\/+$/, '').endsWith('/screenshot')) {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/screenshot`;
  }
  if (token) url.searchParams.set('token', token);
  return url;
}

export function screenshotRequestBody(url: string): string {
  return JSON.stringify({
    url,
    viewport: { width: 1280, height: 1280 },
    options: { type: 'png' },
    gotoOptions: { waitUntil: 'networkidle2', timeout: 5000 },
  });
}

export async function fetchScreenshot(
  targetUrl: string,
  configuration: CheckConfiguration,
  signal: AbortSignal,
): Promise<Buffer | null> {
  if (!configuration.chromeUrl?.trim()) return null;
  try {
    const result = await request(browserlessScreenshotUrl(configuration.chromeUrl, configuration.chromeToken), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(SCREENSHOT_TIMEOUT_MS)]),
      method: 'POST',
      body: screenshotRequestBody(targetUrl),
      readTimeoutMs: SCREENSHOT_TIMEOUT_MS,
      collectBody: true,
    });
    return result.status >= 200 && result.status < 300 && result.body.subarray(0, 8).equals(PNG_MAGIC)
      ? result.body : null;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    // Browserless outages/non-image responses clear previews without marking a
    // healthy service unavailable or making the entire check retry forever.
    return null;
  }
}

export interface ProtocolObservation {
  up: boolean;
  status: number | null;
  error: string | null;
  durationMs: number | null;
}

async function checkAvailability(service: ServiceSnapshot, secure: boolean, signal: AbortSignal): Promise<ProtocolObservation> {
  const started = performance.now();
  try {
    const result = await request(serviceUrl(service, secure), { signal });
    const up = result.status >= 200 && result.status < 400;
    return { up, status: result.status, error: up ? null : `HTTP ${result.status}`,
      durationMs: Math.max(0, performance.now() - started) };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    return { up: false, status: null, durationMs: null,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 1000) };
  }
}

async function snapshot(serviceId: string): Promise<ServiceSnapshot | undefined> {
  const found = await jobDatabase().query<ServiceSnapshot>(
    `SELECT s.id, s."dashboardId", s.host, s.port, s.http, s.https, s."httpPath", s."httpPathLast", s."httpsPathLast",
       s."httpPreview", s."configRevision", s."checkedAt" AT TIME ZONE 'UTC' AS "checkedAt", s."screenshotCheckedAt", s."availabilityCheckRequestedAt", d."monitoringRevision",
       d."monitoringEnabled", d."screenshotsEnabled", d."checkIntervalSeconds", d."screenshotIntervalSeconds",
       d."screenshotDemandUntil"
     FROM "Service" s JOIN "Dashboard" d ON d.id = s."dashboardId" WHERE s.id = $1`, [serviceId],
  );
  return found.rows[0];
}

/** Availability and screenshots only share the durable queue and target snapshot. */
export async function checkService(job: ServiceCheckJob, configuration: CheckConfiguration, signal: AbortSignal): Promise<boolean> {
  if (job.kind === 'screenshot') return checkServiceScreenshot(job, configuration, signal);
  signal.throwIfAborted();
  const service = await snapshot(job.serviceId);
  if (!service || !service.monitoringEnabled || !(service.http || service.https)
    || (!service.availabilityCheckRequestedAt && service.checkedAt && service.checkedAt.getTime() > Date.now() - service.checkIntervalSeconds * 1000)) {
    // A settings edit can request a check while this claim waits for its locks.
    // Leave it due; claim eligibility still enforces pauses and normal cadence.
    await withOwnedJob(job, async () => false);
    return false;
  }
  const observation = {
    http: service.http ? await checkAvailability(service, false, signal) : null,
    https: service.https ? await checkAvailability(service, true, signal) : null,
  };
  signal.throwIfAborted();
  let changed = false;
  await withOwnedJob(job, async (client) => {
    signal.throwIfAborted();
    // History follows accepted observations. A completion waiting on settings or
    // maintenance locks must not write a result into an already closed period.
    const observedAt = new Date();
    const result = await client.query<{ dashboardId: string | null }>(
      `UPDATE "Service" s SET "httpPathLast" = $4, "httpsPathLast" = $5,
         "checkedAt" = $6::timestamptz AT TIME ZONE 'UTC', "availabilityCheckRequestedAt" = NULL,
         "updatedAt" = clock_timestamp() AT TIME ZONE 'UTC'
       FROM "Dashboard" d WHERE s.id = $1 AND s."configRevision" = $2
         AND d.id = s."dashboardId" AND d."monitoringRevision" = $3 AND d."monitoringEnabled"
         AND (s.http IS TRUE OR s.https IS TRUE) RETURNING s."dashboardId"`,
      [service.id, service.configRevision, service.monitoringRevision,
        observation.http?.up ?? service.httpPathLast, observation.https?.up ?? service.httpsPathLast, observedAt],
    );
    if (!result.rowCount) return false;
    await recordAvailabilityObservation(client, service.id, observation, observedAt);
    changed = true;
    if (service.dashboardId) {
      await client.query(`UPDATE "Dashboard" SET "updatedAt" = clock_timestamp() AT TIME ZONE 'UTC' WHERE id = $1`, [service.dashboardId]);
    }
    signal.throwIfAborted();
  });
  return changed;
}

export async function checkServiceScreenshot(job: ServiceCheckJob, configuration: CheckConfiguration, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  const service = await snapshot(job.serviceId);
  if (!service || !service.screenshotsEnabled || !service.httpPreview || !(service.http || service.https)
    || !service.screenshotDemandUntil || service.screenshotDemandUntil.getTime() <= Date.now()
    || (service.screenshotCheckedAt && service.screenshotCheckedAt.getTime() > Date.now() - service.screenshotIntervalSeconds * 1000)) {
    await withOwnedJob(job, async () => {});
    return false;
  }
  let screenshot = await fetchScreenshot(serviceUrl(service, Boolean(service.https)).toString(), configuration, signal);
  let preview: Buffer | null = null;
  if (screenshot) {
    try { preview = await createScreenshotPreview(screenshot); }
    catch { screenshot = null; }
  }
  signal.throwIfAborted();
  let changed = false;
  await withOwnedJob(job, async (client) => {
    signal.throwIfAborted();
    const result = await client.query(
      `UPDATE "Service" s SET "httpScreenshot" = $4, "httpScreenshotHash" = $5, "httpScreenshotPreview" = $6,
         "screenshotCheckedAt" = clock_timestamp() AT TIME ZONE 'UTC', "updatedAt" = clock_timestamp() AT TIME ZONE 'UTC'
       FROM "Dashboard" d WHERE s.id = $1 AND s."configRevision" = $2 AND s."httpPreview" IS TRUE
         AND d.id = s."dashboardId" AND d."monitoringRevision" = $3 AND d."screenshotsEnabled"
         AND d."screenshotDemandUntil" > clock_timestamp()
         AND (s.http IS TRUE OR s.https IS TRUE)`,
      [service.id, service.configRevision, service.monitoringRevision, screenshot,
        screenshot ? screenshotHash(screenshot) : null, preview],
    );
    changed = Boolean(result.rowCount);
    if (!changed) return false;
    if (service.dashboardId) {
      await client.query(`UPDATE "Dashboard" SET "updatedAt" = clock_timestamp() AT TIME ZONE 'UTC' WHERE id = $1`, [service.dashboardId]);
    }
    signal.throwIfAborted();
  });
  return changed;
}
