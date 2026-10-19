import type { ServiceAttributes } from '@stakeout/core';

export class MonitoredService implements Omit<ServiceAttributes, 'created_at' | 'updated_at'> {
  dashboard_id: string | null = null;
  id = '';
  name = '';
  host = '';
  port = 0;
  http = false;
  https = false;
  http_path = '';
  http_path_last = true;
  https_path_last = true;
  http_xquery = '';
  http_xquery_last = true;
  http_preview = false;
  http_screenshot = '';

  checked_at: string | null = null;

  created_at: string | null = null;
  updated_at: string | null = null;
}
