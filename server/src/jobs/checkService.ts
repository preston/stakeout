import http from 'node:http';
import https from 'node:https';
import { jobDatabase, STALE_CHECK_MS, withOwnedJob, type ServiceCheckJob } from './queue.ts';

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
  dashboard_id: string | null;
  host: string;
  port: number;
  http: boolean | null;
  https: boolean | null;
  http_path: string;
  http_path_last: boolean | null;
  https_path_last: boolean | null;
  http_preview: boolean | null;
  revision: string;
  stale: boolean;
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

export function serviceUrl(service: Pick<ServiceSnapshot, 'host' | 'port' | 'http_path'>, secure: boolean): URL {
  const host = service.host.includes(':') && !service.host.startsWith('[') ? `[${service.host}]` : service.host;
  const base = new URL(`${secure ? 'https' : 'http'}://${host}`);
  if (service.port !== 0) base.port = String(service.port);
  const path = service.http_path.startsWith('/') ? service.http_path : `/${service.http_path}`;
  return new URL(`${base.origin}${path}`);
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

async function checkAvailability(service: ServiceSnapshot, secure: boolean, signal: AbortSignal): Promise<boolean> {
  try {
    const result = await request(serviceUrl(service, secure), { signal });
    return result.status >= 200 && result.status < 400;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    return false;
  }
}

/** Returns false for missing, freshly checked, edited, or no-longer-owned jobs. */
export async function checkService(
  job: ServiceCheckJob,
  configuration: CheckConfiguration,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  const found = await jobDatabase().query<ServiceSnapshot>(
    `SELECT id, dashboard_id, host, port, http, https, http_path, http_path_last, https_path_last, http_preview,
       xmin::text AS revision,
       (checked_at IS NULL OR checked_at < (now() AT TIME ZONE 'UTC') - $2 * interval '1 millisecond') AS stale
     FROM services WHERE id = $1`,
    [job.service_id, STALE_CHECK_MS],
  );
  const service = found.rows[0];
  if (!service || !service.stale) {
    await withOwnedJob(job, async () => {});
    return false;
  }
  let httpLast = service.http_path_last;
  let httpsLast = service.https_path_last;
  if (service.http) httpLast = await checkAvailability(service, false, signal);
  if (service.https) httpsLast = await checkAvailability(service, true, signal);
  let screenshot: Buffer | null = null;
  if (service.http_preview && (service.http || service.https)) {
    try {
      screenshot = await fetchScreenshot(serviceUrl(service, Boolean(service.https)).toString(), configuration, signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
    }
  }
  signal.throwIfAborted();
  let changed = false;
  await withOwnedJob(job, async (client) => {
    signal.throwIfAborted();
    const result = await client.query<{ dashboard_id: string | null }>(
      `UPDATE services SET http_path_last = $3, https_path_last = $4, http_screenshot = $5,
         checked_at = clock_timestamp() AT TIME ZONE 'UTC', updated_at = clock_timestamp() AT TIME ZONE 'UTC'
       WHERE id = $1 AND xmin::text = $2 RETURNING dashboard_id`,
      [service.id, service.revision, httpLast, httpsLast, screenshot],
    );
    changed = (result.rowCount ?? 0) > 0;
    const dashboardId = result.rows[0]?.dashboard_id;
    if (dashboardId) {
      await client.query(`UPDATE dashboards SET updated_at = clock_timestamp() AT TIME ZONE 'UTC' WHERE id = $1`, [dashboardId]);
    }
    signal.throwIfAborted();
  });
  return changed;
}
