// Author: Preston Lee

import { Component, OnInit, computed, inject, signal, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpClient } from '@angular/common/http';
import { form, FormField } from '@angular/forms/signals';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { UserDto } from '@stakeout/core';
import { API_URL, AuthService } from '../../core/services/auth.service';
import { apiErrorMessage } from '../../core/utils/api-error.util';

const emptyDraft = () => ({ username: '', displayName: '', isActive: true, password: '', confirmation: '' });

@Component({ selector: 'app-users', imports: [FormField], templateUrl: './users.component.html' })
export class UsersComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  readonly users = signal<UserDto[]>([]);
  readonly search = signal('');
  readonly selectedId = signal<string | null>(null);
  readonly creating = signal(false);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly message = signal('');
  readonly draft = signal(emptyDraft());
  readonly userForm = form(this.draft);
  readonly filteredUsers = computed(() => {
    const query = this.search().trim().toLowerCase();
    return this.users().filter(user => `${user.username} ${user.displayName}`.toLowerCase().includes(query));
  });
  readonly selected = computed(() => this.users().find(user => user.id === this.selectedId()) ?? null);

  ngOnInit(): void { void this.load(); }
  async load(): Promise<void> {
    const version = this.auth.accountVersion();
    this.loading.set(true);
    try {
      const users = await firstValueFrom(this.http.get<UserDto[]>(`${API_URL}/admin/users`).pipe(takeUntilDestroyed(this.destroyRef)));
      if (this.isCurrent(version)) this.users.set(users);
    } catch (error) { if (this.isCurrent(version)) this.error.set(apiErrorMessage(error)); }
    finally { if (!this.destroyRef.destroyed) this.loading.set(false); }
  }
  select(user: UserDto): void {
    if (this.busy()) return;
    this.creating.set(false); this.selectedId.set(user.id); this.error.set(''); this.message.set('');
    this.draft.set({ ...emptyDraft(), username: user.username, displayName: user.displayName, isActive: user.isActive });
  }
  create(): void {
    this.selectedId.set(null); this.creating.set(true); this.draft.set(emptyDraft()); this.error.set(''); this.message.set('');
  }
  searchChanged(event: Event): void { this.search.set((event.target as HTMLInputElement).value); }

  async save(event: Event): Promise<void> {
    event.preventDefault();
    await this.run(async version => {
      const { username, displayName, isActive, password, confirmation } = this.draft();
      const creating = this.creating();
      if (creating && password !== confirmation) throw { error: { message: 'The passwords do not match.' } };
      const input = { username, displayName, isActive, ...(creating ? { password } : {}) };
      const operation = creating ? this.http.post<UserDto>(`${API_URL}/admin/users`, input)
        : this.http.patch<UserDto>(`${API_URL}/admin/users/${this.selectedId()}`, input);
      const user = await firstValueFrom(operation.pipe(takeUntilDestroyed(this.destroyRef)));
      if (!this.isCurrent(version)) return;
      if (user.id === this.auth.session()?.user.id) {
        if (!user.isActive) { this.auth.clear(); await this.router.navigateByUrl('/'); return; }
        this.auth.updateUser(user);
      }
      await this.load();
      if (!this.isCurrent(version)) return;
      this.creating.set(false); this.selectedId.set(user.id);
      this.draft.set({ ...emptyDraft(), username: user.username, displayName: user.displayName, isActive: user.isActive });
      this.message.set(creating ? 'User created.' : 'User saved.');
    });
  }
  async resetPassword(event: Event): Promise<void> {
    event.preventDefault();
    await this.run(async version => {
      const { password, confirmation } = this.draft();
      if (password !== confirmation) throw { error: { message: 'The passwords do not match.' } };
      await firstValueFrom(this.http.post<void>(`${API_URL}/admin/users/${this.selectedId()}/password`, { password }).pipe(takeUntilDestroyed(this.destroyRef)));
      if (!this.isCurrent(version)) return;
      this.draft.update(d => ({ ...d, password: '', confirmation: '' }));
      if (this.selectedId() === this.auth.session()?.user.id) { this.auth.clear(); await this.router.navigateByUrl('/'); return; }
      this.message.set('Password reset. The user’s existing sessions have been signed out.');
    });
  }
  async remove(): Promise<void> {
    const user = this.selected();
    if (!user || !window.confirm(`Permanently delete ${user.username}?`)) return;
    await this.run(async version => {
      await firstValueFrom(this.http.delete<void>(`${API_URL}/admin/users/${user.id}`).pipe(takeUntilDestroyed(this.destroyRef)));
      if (!this.isCurrent(version)) return;
      if (user.id === this.auth.session()?.user.id) { this.auth.clear(); await this.router.navigateByUrl('/'); return; }
      this.selectedId.set(null); await this.load();
      if (this.isCurrent(version)) this.message.set('User deleted.');
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
