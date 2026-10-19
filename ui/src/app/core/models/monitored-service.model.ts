export class MonitoredService {
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

  checked_at: Date | string | null = null;

  created_at: Date | null = null;
  updated_at: Date | null = null;
}
