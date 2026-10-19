import { Service, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Status } from '../models/status.model';
import { API_URL } from './auth.service';

@Service()
export class BackendService {
  static readonly STATUS_PATH = '/status';

  private readonly http = inject(HttpClient);

  readonly url = API_URL;

  headers(): HttpHeaders {
    let headers = new HttpHeaders({
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    return headers;
  }

  statusUrl(): string {
    return this.url + BackendService.STATUS_PATH;
  }

  status() {
    return this.http.get<Status>(this.statusUrl(), { headers: this.headers() });
  }

}
