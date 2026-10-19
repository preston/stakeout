// Author: Preston Lee

import { ApplicationConfig, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideNgToast, TOAST_POSITIONS } from 'ng-angular-popup';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(routes),
    provideHttpClient(),
    provideNgToast({
      duration: 5000,
      position: TOAST_POSITIONS.BOTTOM_RIGHT,
      dismissible: true,
    }),
  ],
};
