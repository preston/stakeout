// Author: Preston Lee

import { Component, effect, inject, signal, untracked, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpClient } from '@angular/common/http';
import { form, FormField } from '@angular/forms/signals';
import { firstValueFrom } from 'rxjs';
import { DEFAULT_PREFERENCES, type SessionDto, type UserDto, type UserPreferences } from '@stakeout/core';
import { API_URL, AuthService } from '../../core/services/auth.service';
import { SettingsService } from '../../core/services/settings.service';
import { apiErrorMessage } from '../../core/utils/api-error.util';

@Component({ selector: 'app-profile', imports: [FormField], templateUrl: './profile.component.html' })
export class ProfileComponent {
  protected readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);
  private readonly settings = inject(SettingsService);
  private readonly destroyRef = inject(DestroyRef);
  readonly draft = signal<UserPreferences>({ ...this.settings.settings() });
  readonly preferencesForm = form(this.draft);
  readonly identity = signal({ displayName: this.auth.session()?.user.displayName ?? '' });
  readonly identityForm = form(this.identity);
  readonly passwords = signal({ currentPassword: '', password: '', confirmation: '' });
  readonly passwordForm = form(this.passwords);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly message = signal('');

  constructor() {
    effect(() => {
      const preferences = this.draft();
      if (!preferences.developer && preferences.refreshIntervalMs === 5000) {
        untracked(() => this.draft.update(value => ({ ...value, refreshIntervalMs: 60000 })));
      }
    });
  }

  setRefresh(event: Event): void { this.draft.update(d => ({ ...d, refreshIntervalMs: Number((event.target as HTMLSelectElement).value) })); }

  async save(event: Event): Promise<void> {
    event.preventDefault();
    await this.run(async version => {
      const draft = { ...this.draft() };
      const user = await firstValueFrom(this.http.patch<UserDto>(`${API_URL}/users/me`, this.identity()).pipe(takeUntilDestroyed(this.destroyRef)));
      if (!this.isCurrent(version)) return;
      this.auth.updateUser(user);
      await this.settings.savePreferences(draft);
      if (!this.isCurrent(version)) return;
      this.draft.set({ ...this.settings.settings() });
      this.message.set('Profile saved.');
    });
  }

  async reset(): Promise<void> {
    await this.run(async version => {
      await this.settings.savePreferences({ ...DEFAULT_PREFERENCES });
      if (!this.isCurrent(version)) return;
      this.draft.set({ ...this.settings.settings() });
      this.message.set('Preferences restored to defaults.');
    });
  }

  async changePassword(event: Event): Promise<void> {
    event.preventDefault();
    await this.run(async version => {
      const { currentPassword, password, confirmation } = this.passwords();
      if (password !== confirmation) throw { error: { message: 'The new passwords do not match.' } };
      const dto = await firstValueFrom(this.http.post<SessionDto>(`${API_URL}/users/me/password`, { currentPassword, password }).pipe(takeUntilDestroyed(this.destroyRef)));
      if (!this.isCurrent(version) || !this.auth.acceptSession(dto, version)) return;
      this.passwords.set({ currentPassword: '', password: '', confirmation: '' });
      this.message.set('Password changed. Other sessions have been signed out.');
    });
  }

  private isCurrent(version: number): boolean {
    return !this.destroyRef.destroyed && version === this.auth.accountVersion();
  }

  private async run(action: (version: number) => Promise<void>): Promise<void> {
    if (this.busy() || this.destroyRef.destroyed) return;
    const version = this.auth.accountVersion();
    this.busy.set(true); this.error.set(''); this.message.set('');
    try { await action(version); }
    catch (error) { if (this.isCurrent(version)) this.error.set(apiErrorMessage(error)); }
    finally { if (!this.destroyRef.destroyed) this.busy.set(false); }
  }
}
