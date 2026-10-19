// Author: Preston Lee

import { Service, computed, effect, inject, signal, untracked, DestroyRef } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { NgToastService } from 'ng-angular-popup';
import { DEFAULT_PREFERENCES, type UserPreferences } from '@stakeout/core';
import { ThemeType } from '../models/settings.model';
import { API_URL, AuthService } from './auth.service';

@Service()
export class SettingsService {
  private readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);
  private readonly toast = inject(NgToastService);
  private readonly hydratedVersion = signal(-1);
  private readonly state = signal<UserPreferences>({ ...DEFAULT_PREFERENCES });
  private confirmed: UserPreferences = { ...DEFAULT_PREFERENCES };
  private queue: Promise<void> = Promise.resolve();
  private revision = 0;
  private readonly editing = signal(false);
  private readonly darkSystem = signal(window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  readonly settings = computed(() => this.hydratedVersion() === this.auth.accountVersion()
    ? this.state() : this.auth.session()?.preferences ?? DEFAULT_PREFERENCES);
  readonly editable = computed(() => this.auth.isAuthenticated() && this.hydratedVersion() === this.auth.accountVersion() && this.editing());
  readonly screenshots = computed(() => this.settings().screenshots);
  readonly displayMode = computed(() => this.settings().displayMode);
  readonly theme_effective = computed(() => this.settings().themePreferred === 'automatic'
    ? this.darkSystem() ? ThemeType.DARK : ThemeType.LIGHT : this.settings().themePreferred);

  constructor() {
    try {
      localStorage.removeItem('stakeout_settings');
      localStorage.removeItem('stakeout_settings_force_reset');
      sessionStorage.removeItem('stakeout_editable');
    } catch { /* Storage may be disabled; it is no longer needed. */ }
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onThemeChange = (event: MediaQueryListEvent) => this.darkSystem.set(event.matches);
    media?.addEventListener('change', onThemeChange);
    inject(DestroyRef).onDestroy(() => media?.removeEventListener('change', onThemeChange));
    this.syncSession();
    effect(() => {
      this.auth.accountVersion();
      untracked(() => this.syncSession());
    });
  }

  private syncSession(): void {
    const version = this.auth.accountVersion();
    if (this.hydratedVersion() === version) return;
    this.revision++;
    this.confirmed = { ...(this.auth.session()?.preferences ?? DEFAULT_PREFERENCES) };
    this.state.set({ ...this.confirmed });
    this.hydratedVersion.set(version);
    this.editing.set(false);
  }

  setEditable(value: boolean): void { this.syncSession(); this.editing.set(this.auth.isAuthenticated() && value); }
  setScreenshots(value: boolean): void { this.change({ screenshots: value }); }
  setDisplayMode(value: 'wide' | 'overlay'): void { this.change({ displayMode: value }); }

  change(patch: Partial<UserPreferences>): void {
    void this.savePreferences(patch).catch(() => this.toast.danger('Your preference could not be saved. Please try again.', 'Save failed'));
  }

  savePreferences(patch: Partial<UserPreferences>): Promise<void> {
    this.syncSession();
    const version = this.auth.accountVersion();
    const revision = ++this.revision;
    const next = { ...this.state(), ...patch };
    if (!next.developer && next.refreshIntervalMs === 5000) {
      next.refreshIntervalMs = 60000;
      patch = { ...patch, refreshIntervalMs: 60000 };
    }
    this.state.set(next);
    if (!this.auth.isAuthenticated()) return Promise.resolve();
    const operation = this.queue.catch(() => {}).then(async () => {
      if (version !== this.auth.accountVersion()) return;
      try {
        const saved = await firstValueFrom(this.http.patch<UserPreferences>(`${API_URL}/users/me/settings`, patch));
        if (version !== this.auth.accountVersion()) return;
        this.confirmed = saved;
        if (revision === this.revision) this.state.set(saved);
      } catch (error) {
        if (version !== this.auth.accountVersion()) return;
        if (revision === this.revision) this.state.set({ ...this.confirmed });
        throw error;
      }
    });
    this.queue = operation;
    return operation;
  }
}
