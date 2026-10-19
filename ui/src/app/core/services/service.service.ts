import { Service } from '@angular/core';
import { HttpParams } from '@angular/common/http';
import { BaseService } from './base.service';
import { Dashboard } from '../models/dashboard.model';
import { MonitoredService } from '../models/monitored-service.model';
import { DashboardService } from './dashboard.service';

@Service()
export class ServiceService extends BaseService {
  static readonly PATH = '/services';

  url(dashboard: Dashboard): string {
    return (
      this.backendService.url +
      DashboardService.PATH +
      '/' +
      dashboard.id +
      ServiceService.PATH
    );
  }

  index(
    dashboard: Dashboard,
    screenshots: boolean,
    sort = 'name',
    order = 'desc'
  ) {
    const params = new HttpParams()
      .set('sort', sort)
      .set('order', order)
      .set('screenshots', screenshots);
    return this.http.get<MonitoredService[]>(this.url(dashboard), {
      headers: this.headers(),
      params,
    });
  }

  create(dashboard: Dashboard, service: MonitoredService) {
    return this.http.post<MonitoredService>(
      this.url(dashboard),
      { dashboard_id: dashboard.id, service },
      { headers: this.headers() }
    );
  }

  update(dashboard: Dashboard, service: MonitoredService) {
    return this.http.put<MonitoredService>(
      `${this.url(dashboard)}/${service.id}`,
      { dashboard, service },
      { headers: this.headers() }
    );
  }

  delete(dashboard: Dashboard, service: MonitoredService) {
    return this.http.delete<MonitoredService>(
      `${this.url(dashboard)}/${service.id}`,
      { headers: this.headers() }
    );
  }
}
