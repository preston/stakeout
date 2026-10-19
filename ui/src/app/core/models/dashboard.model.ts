import type { DashboardAttributes } from '@stakeout/core';
import { MonitoredService } from './monitored-service.model';

export class Dashboard implements Omit<DashboardAttributes, 'created_at' | 'updated_at'> {
  id = '';
  name = '';
  services: MonitoredService[] = [];
  created_at: string | null = null;
  updated_at: string | null = null;
}
