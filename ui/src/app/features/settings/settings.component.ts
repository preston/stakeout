// Author: Preston Lee

import { Component, DestroyRef, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { form, FormField } from '@angular/forms/signals';
import { Location } from '@angular/common';
import { Router } from '@angular/router';
import { NgToastService } from 'ng-angular-popup';
import { SettingsService } from '../../core/services/settings.service';
import { BackendService } from '../../core/services/backend.service';
import { ToastErrorService } from '../../core/services/toast-error.service';
import { Settings, ThemeType } from '../../core/models/settings.model';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [FormField],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent {
  private readonly toastService = inject(NgToastService);
  protected readonly settingsService = inject(SettingsService);
  private readonly backendService = inject(BackendService);
  private readonly toastErrorService = inject(ToastErrorService);
  protected readonly location = inject(Location);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly ThemeType = ThemeType;

  readonly settingsDraft = signal<Settings>(new Settings());
  readonly settingsForm = form(this.settingsDraft);
  readonly unlocking = signal(false);

  constructor() {
    this.syncDraftFromService();
    effect(() => {
      const theme = this.settingsDraft().theme_preferred;
      untracked(() => this.applyThemePreference(theme));
    });
  }

  private syncDraftFromService(): void {
    this.settingsDraft.set({ ...this.settingsService.settings() });
  }

  private applyThemePreference(theme: ThemeType): void {
    if (this.settingsService.settings().theme_preferred === theme) {
      return;
    }
    this.settingsService.updateSettings({ theme_preferred: theme });
    this.settingsService.setEffectiveTheme();
    this.settingsService.saveSettings();
  }

  editable(): boolean {
    return this.settingsService.editable();
  }

  unlock(): void {
    if (this.unlocking()) {
      return;
    }
    this.settingsService.updateSettings(this.settingsDraft());
    this.settingsService.saveSettings();
    this.unlocking.set(true);
    this.backendService
      .test()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.unlocking.set(false);
          this.toastService.success(
            'Auto-refresh will be disabled while in edit mode.',
            'Authentication Successful'
          );
          this.settingsService.setEditable(true);
          void this.router.navigate(['/']);
        },
        error: (e) => {
          this.unlocking.set(false);
          if (!this.toastErrorService.checkAccessDenied(e)) {
            this.toastService.danger(
              'Failed to authenticate. Check username, password, and Internet connection.',
              'Test Failed'
            );
          }
        },
      });
  }

  lock(): void {
    this.settingsService.setEditable(false);
  }

  save(): void {
    this.settingsService.updateSettings(this.settingsDraft());
    this.settingsService.setEffectiveTheme();
    this.settingsService.saveSettings();
    this.toastService.success(
      'Settings are local to your browser only.',
      'Settings Saved'
    );
    this.back();
  }

  restore(): void {
    this.settingsService.forceResetToDefaults();
    this.syncDraftFromService();
    this.toastService.success(
      'All settings have been restored to their defaults.',
      'Settings Restored'
    );
  }

  back(): void {
    this.location.back();
  }
}
