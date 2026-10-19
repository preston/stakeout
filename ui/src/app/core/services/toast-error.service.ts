// Author: Preston Lee

import { Service, inject } from '@angular/core';
import { NgToastService } from 'ng-angular-popup';
import { httpErrorStatus } from '../utils/http-error.util';
import { SettingsService } from './settings.service';

@Service()
export class ToastErrorService {
  private readonly toastService = inject(NgToastService);
  private readonly settingsService = inject(SettingsService);

  checkAccessDenied(error: unknown): boolean {
    if (httpErrorStatus(error) === 401) {
      this.settingsService.setEditable(false);
      this.toastService.danger(
        'Check your credentials and try again.',
        'Access denied.'
      );
      return true;
    }
    return false;
  }
}
