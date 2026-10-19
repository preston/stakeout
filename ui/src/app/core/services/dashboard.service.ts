import { Service } from '@angular/core';
import { HttpParams } from '@angular/common/http';
import { BaseService } from './base.service';
import { Dashboard } from '../models/dashboard.model';

@Service()
export class DashboardService extends BaseService {
  static readonly PATH = '/dashboards';

  url(): string {
    return this.backendService.url + DashboardService.PATH;
  }

  index(cache = true, sort = 'priority', order = 'desc') {
    const params = new HttpParams().set('sort', sort).set('order', order);
    return this.http.get<Dashboard[]>(this.url(), {
      headers: this.headers(),
      params,
    });
  }

  get(id: string) {
    return this.http.get<Dashboard>(`${this.url()}/${id}`, {
      headers: this.headers(),
    });
  }

  create(dashboard: Dashboard) {
    return this.http.post<Dashboard>(this.url(), { dashboard }, {
      headers: this.headers(),
    });
  }

  update(dashboard: Dashboard) {
    return this.http.put<Dashboard>(`${this.url()}/${dashboard.id}`, { dashboard }, {
      headers: this.headers(),
    });
  }

  delete(dashboard: Dashboard) {
    return this.http.delete<Dashboard>(`${this.url()}/${dashboard.id}`, {
      headers: this.headers(),
    });
  }
}
