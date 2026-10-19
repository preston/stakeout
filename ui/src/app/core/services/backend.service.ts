import { Service, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Status } from '../models/status.model';
import { SettingsService } from './settings.service';

function toBase64(str: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(str)));
}

@Service()
export class BackendService {
  static readonly STATUS_PATH = '/status';
  static readonly TEST_PATH = '/test';

  private readonly http = inject(HttpClient);
  private readonly settingsService = inject(SettingsService);

  readonly url: string =
    (window as unknown as { STAKEOUT_UI_SERVER_URL?: string })['STAKEOUT_UI_SERVER_URL'] ?? '';

  headers(): HttpHeaders {
    let headers = new HttpHeaders({
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    const s = this.settingsService.settings();
    const b64token = toBase64(`${s.cds_username}:${s.cds_password}`);
    headers = headers.set('Authorization', 'Basic ' + b64token);
    return headers;
  }

  statusUrl(): string {
    return this.url + BackendService.STATUS_PATH;
  }

  testUrl(): string {
    return this.url + BackendService.TEST_PATH;
  }

  status() {
    return this.http.get<Status>(this.statusUrl(), { headers: this.headers() });
  }

  test() {
    return this.http.post<Status>(this.testUrl(), {}, { headers: this.headers() });
  }
}
