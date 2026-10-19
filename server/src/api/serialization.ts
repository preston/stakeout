// Author: Preston Lee

import type { Dashboard, Service } from '@prisma/client';
import type { Request } from 'express';
import type { DashboardAttributes, DashboardDto, ServiceAttributes, ServiceDto, ServiceMutationDto } from '@stakeout/core';

export function dashboardAttributes(dashboard: Dashboard): DashboardAttributes {
  return {
    id: dashboard.id,
    name: dashboard.name,
    created_at: dashboard.created_at.toISOString(),
    updated_at: dashboard.updated_at.toISOString(),
  };
}

function absoluteUrl(request: Request, path: string): string {
  return `${request.protocol}://${request.host}${path}`;
}

export function dashboardDto(dashboard: Dashboard, request: Request): DashboardDto {
  const path = `/dashboards/${dashboard.id}`;
  return { ...dashboardAttributes(dashboard), path, url: absoluteUrl(request, path) };
}

export function serviceAttributes(service: Service): ServiceAttributes {
  return {
    id: service.id,
    dashboard_id: service.dashboard_id,
    name: service.name,
    host: service.host,
    port: service.port,
    http: service.http,
    https: service.https,
    http_path: service.http_path,
    http_path_last: service.http_path_last,
    https_path_last: service.https_path_last,
    http_xquery: service.http_xquery,
    http_xquery_last: service.http_xquery_last,
    http_preview: service.http_preview,
    checked_at: service.checked_at?.toISOString() ?? null,
    created_at: service.created_at.toISOString(),
    updated_at: service.updated_at.toISOString(),
  };
}

/** Ruby Base64.encode64 uses 60-character lines, including a trailing newline. */
export function rubyBase64(bytes: Uint8Array): string {
  const encoded = Buffer.from(bytes).toString('base64');
  return encoded.match(/.{1,60}/g)?.map(line => `${line}\n`).join('') ?? '';
}

export function serviceDto(service: Service, request: Request, screenshots = false): ServiceDto {
  const path = `/dashboards/${service.dashboard_id}/services/${service.id}`;
  const dto: ServiceDto = { ...serviceAttributes(service), path, url: absoluteUrl(request, path) };
  if (screenshots) dto.http_screenshot = service.http_screenshot === null ? null : rubyBase64(service.http_screenshot);
  return dto;
}

export function serviceMutationDto(service: Service): ServiceMutationDto {
  return {
    ...serviceAttributes(service),
    http_screenshot: service.http_screenshot === null ? null : Buffer.from(service.http_screenshot).toString('utf8'),
  };
}
