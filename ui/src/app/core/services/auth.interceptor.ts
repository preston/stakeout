// Author: Preston Lee

import { inject } from '@angular/core';
import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { API_URL, AuthService } from './auth.service';

export const authInterceptor: HttpInterceptorFn = (request, next) => {
  if (!(request.url === API_URL || request.url.startsWith(`${API_URL}/`))) return next(request);
  const auth = inject(AuthService);
  const router = inject(Router);
  const version = auth.accountVersion();
  const csrf = auth.session()?.csrfToken;
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  const outgoing = request.clone({ withCredentials: true, setHeaders: {
    Accept: 'application/json', ...(mutation && csrf ? { 'X-CSRF-Token': csrf } : {}),
  } });
  return next(outgoing).pipe(catchError((error: unknown) => {
    if (error instanceof HttpErrorResponse && error.status === 401 && !request.url.endsWith('/auth/login') && version === auth.accountVersion()) {
      auth.clear();
      if (/^\/(admin|profile)(\/|$)/.test(router.url)) void router.navigateByUrl('/');
    }
    return throwError(() => error);
  }));
};
