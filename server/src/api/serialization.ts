// Author: Preston Lee

import type { Dashboard, Service } from '@prisma/client';
import type { Request } from 'express';
import type { DashboardAttributes, DashboardDto, ServiceAttributes, ServiceDto, ServiceMutationDto } from '@stakeout/core';
import { PREVIEW_FILENAME } from '../screenshots.ts';

type ServiceMetadata = Omit<Service, 'httpScreenshot' | 'httpScreenshotPreview'>;

export function dashboardAttributes(dashboard: Dashboard): DashboardAttributes {
  return {
    id: dashboard.id,
    name: dashboard.name,
    created_at: dashboard.createdAt.toISOString(),
    updated_at: dashboard.updatedAt.toISOString(),
    monitoring_enabled: dashboard.monitoringEnabled,
    check_interval_seconds: dashboard.checkIntervalSeconds,
    screenshots_enabled: dashboard.screenshotsEnabled,
    screenshot_interval_seconds: dashboard.screenshotIntervalSeconds,
    hourly_retention_days: dashboard.hourlyRetentionDays,
    daily_retention_days: dashboard.dailyRetentionDays,
    availability_retention_days: dashboard.availabilityRetentionDays,
  };
}

function absoluteUrl(request: Request, path: string): string {
  return `${request.protocol}://${request.host}${path}`;
}

export function dashboardDto(dashboard: Dashboard, request: Request): DashboardDto {
  const path = `/dashboards/${dashboard.id}`;
  return { ...dashboardAttributes(dashboard), path, url: absoluteUrl(request, path) };
}

export function serviceAttributes(service: ServiceMetadata): ServiceAttributes {
  return {
    id: service.id,
    dashboard_id: service.dashboardId,
    name: service.name,
    host: service.host,
    port: service.port,
    http: service.http,
    https: service.https,
    http_path: service.httpPath,
    http_path_last: service.httpPathLast,
    https_path_last: service.httpsPathLast,
    http_xquery: service.httpXquery,
    http_xquery_last: service.httpXqueryLast,
    http_preview: service.httpPreview,
    checked_at: service.checkedAt?.toISOString() ?? null,
    created_at: service.createdAt.toISOString(),
    updated_at: service.updatedAt.toISOString(),
  };
}

/** Ruby Base64.encode64 uses 60-character lines, including a trailing newline. */
export function rubyBase64(bytes: Uint8Array): string {
  const encoded = Buffer.from(bytes).toString('base64');
  return encoded.match(/.{1,60}/g)?.map(line => `${line}\n`).join('') ?? '';
}

export function serviceDto(
  service: ServiceMetadata & { httpScreenshot?: Uint8Array | null },
  request: Request,
  screenshots: boolean | 'urls' = false,
): ServiceDto {
  const path = `/dashboards/${service.dashboardId}/services/${service.id}`;
  const dto: ServiceDto = { ...serviceAttributes(service), path, url: absoluteUrl(request, path) };
  if (screenshots === true) dto.http_screenshot = service.httpScreenshot == null ? null : rubyBase64(service.httpScreenshot);
  if (screenshots === 'urls') {
    const base = `${path}/screenshots/${service.httpScreenshotHash}`;
    dto.screenshot = service.httpScreenshotHash ? {
      preview_url: absoluteUrl(request, `${base}/${PREVIEW_FILENAME}`),
      original_url: absoluteUrl(request, `${base}/original.png`),
    } : null;
  }
  return dto;
}

export function serviceMutationDto(service: Service): ServiceMutationDto {
  return {
    ...serviceAttributes(service),
    http_screenshot: service.httpScreenshot === null ? null : Buffer.from(service.httpScreenshot).toString('utf8'),
  };
}
