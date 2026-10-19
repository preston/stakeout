/** Availability is measured at observation time; unknown periods are never uptime. */
export type AvailabilityState = 'up' | 'degraded' | 'down' | 'unknown' | 'paused';
export type TimelineState = AvailabilityState | 'not_retained' | 'not_monitored';

export interface DashboardMonitoringSettings {
  monitoring_enabled: boolean;
  check_interval_seconds: number;
  screenshots_enabled: boolean;
  screenshot_interval_seconds: number;
  hourly_retention_days: number | null;
  daily_retention_days: number | null;
  availability_retention_days: number | null;
}

export const DEFAULT_MONITORING_SETTINGS: Readonly<DashboardMonitoringSettings> = {
  monitoring_enabled: true, check_interval_seconds: 60,
  screenshots_enabled: true, screenshot_interval_seconds: 60,
  hourly_retention_days: 14, daily_retention_days: null, availability_retention_days: null,
};

export interface AvailabilityStatistics {
  uptime_percent: number | null;
  coverage_percent: number | null;
  up_ms: number;
  degraded_ms: number;
  down_ms: number;
  unknown_ms: number;
  paused_ms: number;
  known_ms: number;
  total_ms: number;
  outage_count: number;
}

export interface ProtocolPerformance {
  count: number;
  failures: number;
  response_count: number;
  average_ms: number | null;
  min_ms: number | null;
  max_ms: number | null;
}

export interface TimelineBucket {
  from: string;
  to: string;
  state: TimelineState;
  states: TimelineState[];
}

export interface HistoryServiceSummary {
  service_id: string;
  name: string;
  host: string;
  current_state: AvailabilityState;
  latest_check_at: string | null;
  statistics: AvailabilityStatistics;
  timeline: TimelineBucket[];
  performance: { http: ProtocolPerformance; https: ProtocolPerformance };
  history_started_at: string;
  availability_pruned_before: string | null;
}

export interface HistoryPagination {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
}

export interface HistoryResponse {
  from: string;
  to: string;
  generated_at: string;
  services: HistoryServiceSummary[];
  summary: AvailabilityStatistics;
  current_counts?: Record<AvailabilityState, number>;
  pagination: HistoryPagination;
}

export interface HistoryEvent {
  id: string;
  service_id: string;
  service_name: string;
  at: string;
  state: AvailabilityState;
  previous_state: AvailabilityState | null;
  kind: string;
  reason: string | null;
  configuration_id: string;
}

export interface EventsResponse {
  from: string;
  to: string;
  generated_at: string;
  events: HistoryEvent[];
  pagination: HistoryPagination;
}

export interface HistoryConfiguration {
  id: string;
  revision: number;
  host: string;
  port: number;
  http: boolean;
  https: boolean;
  http_path: string;
  http_xquery: string | null;
}

export interface HistoryInterval {
  id: string;
  from: string;
  to: string;
  state: AvailabilityState;
  http_state: 'up' | 'down' | null;
  https_state: 'up' | 'down' | null;
  reason: string | null;
  http_status: number | null;
  https_status: number | null;
  http_error: string | null;
  https_error: string | null;
  last_observed_at: string | null;
  event_kind: string;
  configuration: HistoryConfiguration;
}

export interface HistoryOutage {
  from: string;
  to: string;
  ongoing: boolean;
  interrupted_by: 'unknown' | 'paused' | 'target_changed' | null;
}

export interface HistoryPerformanceBucket {
  from: string;
  to: string;
  http: ProtocolPerformance;
  https: ProtocolPerformance;
}

export interface ServiceHistoryResponse extends HistoryServiceSummary {
  from: string;
  to: string;
  generated_at: string;
  intervals: HistoryInterval[];
  performance_resolution: 'hour' | 'day' | 'mixed';
  performance_buckets: HistoryPerformanceBucket[];
  outages: HistoryOutage[];
  outage_pagination: HistoryPagination;
  selected_event: HistoryEvent | null;
  pagination: HistoryPagination;
}

export interface HistoryQuery {
  from?: string;
  to?: string;
  service_id?: string;
  state?: AvailabilityState;
  page?: number;
  outage_page?: number;
  event_id?: string;
  limit?: number;
  sort?: 'name' | 'state' | 'uptime' | 'downtime' | 'outage_count' | 'latest_check_at' | 'response_ms';
  order?: 'asc' | 'desc';
}
