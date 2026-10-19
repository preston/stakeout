// Author: Preston Lee

import { ApplicationConfig, provideZonelessChangeDetection, provideAppInitializer, inject } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideNgToast, TOAST_POSITIONS } from 'ng-angular-popup';
import { AuthService } from './core/services/auth.service';
import { authInterceptor } from './core/services/auth.interceptor';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(routes),
    provideHttpClient(withInterceptors([authInterceptor])),
    provideAppInitializer(() => inject(AuthService).restore()),
    provideNgToast({
      duration: 5000,
      position: TOAST_POSITIONS.BOTTOM_RIGHT,
      dismissible: true,
    }),
  ],
};
