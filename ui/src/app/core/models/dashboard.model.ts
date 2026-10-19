import { MonitoredService } from './monitored-service.model';

export class Dashboard {
  id = '';
  name = '';
  services: MonitoredService[] = [];
  created_at: Date | null = null;
  updated_at: Date | null = null;
}
