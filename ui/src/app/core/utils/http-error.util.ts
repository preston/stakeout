import { HttpErrorResponse } from '@angular/common/http';

export interface ApiErrorBody {
  errors?: Record<string, string[]>;
  message?: string;
}

export function apiErrorsFromHttpError(error: unknown): Record<string, string[]> {
  if (error instanceof HttpErrorResponse) {
    const body = error.error as ApiErrorBody | null;
    if (body && typeof body === 'object') {
      if (body.errors) return body.errors;
      const fields = Object.entries(body).filter(([, value]) =>
        Array.isArray(value) && value.every((item: unknown) => typeof item === 'string')
      );
      if (fields.length) return Object.fromEntries(fields) as Record<string, string[]>;
      if (typeof body.message === 'string') return { base: [body.message] };
    }
  }
  return {};
}

export function httpErrorStatus(error: unknown): number | undefined {
  return error instanceof HttpErrorResponse ? error.status : undefined;
}
