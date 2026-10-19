import { HttpErrorResponse } from '@angular/common/http';

export interface ApiErrorBody {
  errors?: Record<string, string[]>;
}

export function apiErrorsFromHttpError(error: unknown): Record<string, string[]> {
  if (error instanceof HttpErrorResponse) {
    const body = error.error as ApiErrorBody | null;
    if (body && typeof body === 'object' && body.errors) {
      return body.errors;
    }
  }
  return {};
}

export function httpErrorStatus(error: unknown): number | undefined {
  return error instanceof HttpErrorResponse ? error.status : undefined;
}
