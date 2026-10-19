import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { API_URL } from './auth.service';
import type { DashboardEventsResponse, DashboardHistoryResponse, HistoryQuery, ServiceHistoryResponse } from '../models/history.model';

@Injectable({ providedIn: 'root' })
export class HistoryService {
  private readonly http = inject(HttpClient);
  private url(id: string): string { return `${API_URL}/dashboards/${encodeURIComponent(id)}`; }
  private params(query: HistoryQuery): HttpParams {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params = params.set(key, String(value));
    return params;
  }
  history(id: string, query: HistoryQuery) {
    return this.http.get<DashboardHistoryResponse>(`${this.url(id)}/history`, { params: this.params(query) });
  }
  events(id: string, query: HistoryQuery) {
    return this.http.get<DashboardEventsResponse>(`${this.url(id)}/events`, { params: this.params(query) });
  }
  service(id: string, serviceId: string, query: HistoryQuery) {
    return this.http.get<ServiceHistoryResponse>(`${this.url(id)}/services/${encodeURIComponent(serviceId)}/history`, { params: this.params(query) });
  }
  exportUrl(id: string, query: HistoryQuery, dataset: 'services' | 'events'): string {
    return `${this.url(id)}/history/export.csv?${this.params(query).set('dataset', dataset)}`;
  }
  screenshotDemand(id: string) { return this.http.post<{ expires_at?: string }>(`${this.url(id)}/screenshot-demand`, {}); }
}
