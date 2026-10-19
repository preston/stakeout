import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { BackendService } from './backend.service';
import { apiErrorsFromHttpError } from '../utils/http-error.util';

/** Shared HTTP helpers for concrete services registered with {@link Service}. */
@Injectable({ providedIn: null })
export abstract class BaseService {
  protected readonly backendService = inject(BackendService);
  protected readonly http = inject(HttpClient);

  headers(): HttpHeaders {
    return this.backendService.headers();
  }

  formatErrors(errors: { [field: string]: string[] }): string[] {
    const formatted: string[] = [];
    for (const [key, msgs] of Object.entries(errors)) {
      for (const msg of msgs) {
        formatted.push(`${key} ${msg}`);
      }
    }
    return formatted;
  }

  formatErrorsHtml(errors: { [field: string]: string[] }): string {
    let html = '<ul>';
    for (const e of this.formatErrors(errors)) {
      html += `<li>${e}</li>`;
    }
    html += '</ul>';
    return html;
  }

  formatErrorsText(errors: { [field: string]: string[] }): string {
    return this.formatErrors(errors).join(', ');
  }

  formatErrorsTextFromResponse(error: unknown): string {
    return this.formatErrorsText(apiErrorsFromHttpError(error));
  }
}
