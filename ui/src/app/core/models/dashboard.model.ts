import type { DashboardAttributes } from '@stakeout/core';
import { MonitoredService } from './monitored-service.model';

export class Dashboard implements Omit<DashboardAttributes, 'created_at' | 'updated_at'> {
  id = '';
  name = '';
  monitoring_enabled = true;
  check_interval_seconds = 60;
  screenshots_enabled = true;
  screenshot_interval_seconds = 60;
  hourly_retention_days: number | null = 14;
  daily_retention_days: number | null = null;
  availability_retention_days: number | null = null;
  services: MonitoredService[] = [];
  created_at: string | null = null;
  updated_at: string | null = null;
}
