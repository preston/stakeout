// Author: Preston Lee

/** Public JSON attributes shared by the browser and HTTP API. */
export interface DashboardAttributes extends Partial<import('./history.js').DashboardMonitoringSettings> {
  id: string;
  name: string | null;
  created_at: string;
  updated_at: string;
}

export interface DashboardDto extends DashboardAttributes {
  path: string;
  url: string;
}

export interface ServiceAttributes {
  id: string;
  dashboard_id: string | null;
  name: string;
  host: string;
  port: number;
  http: boolean | null;
  https: boolean | null;
  http_path: string;
  http_path_last: boolean | null;
  https_path_last: boolean | null;
  http_xquery: string | null;
  http_xquery_last: boolean | null;
  http_preview: boolean | null;
  checked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ServiceDto extends ServiceAttributes {
  http_screenshot?: string | null;
  screenshot?: { preview_url: string; original_url: string } | null;
  path: string;
  url: string;
}

export interface ServiceMutationDto extends ServiceAttributes {
  http_screenshot: string | null;
}

export interface StatusDto {
  message: string;
  server: { datetime: string };
  database: { datetime: string };
}

export type ValidationErrors = Record<string, string[]>;

export * from './account.js';
export * from './history.js';
export * from './service-url.js';
