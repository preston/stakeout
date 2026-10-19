/** The same target address is used by checks, captures, and dashboard links. */
export function serviceTargetUrl(service: { host: string; port: number; http_path: string }, secure: boolean): string {
  const host = service.host.includes(':') && !service.host.startsWith('[') ? `[${service.host}]` : service.host;
  const port = service.port ? `:${service.port}` : '';
  const path = service.http_path.startsWith('/') ? service.http_path : `/${service.http_path}`;
  return `${secure ? 'https' : 'http'}://${host}${port}${path}`;
}
