// Author: Preston Lee

import { Service, computed, inject, signal, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, timer, timeout, type Subscription } from 'rxjs';
import type { SessionDto, UserDto } from '@stakeout/core';

export const SESSION_RESTORE_TIMEOUT_MS = 8000;

export const API_URL = ((window as unknown as { STAKEOUT_UI_SERVER_URL?: string }).STAKEOUT_UI_SERVER_URL ?? '').replace(/\/$/, '');
export function localReturnUrl(value: string | null): string {
  return value?.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && !/^\/login(?:[/?#]|$)/.test(value) ? value : '/';
}

@Service()
export class AuthService {
  private readonly http = inject(HttpClient);
  readonly session = signal<SessionDto | null>(null);
  readonly accountVersion = signal(0);
  readonly isAuthenticated = computed(() => this.session() !== null);
  private restoring?: Promise<void>;
  private expiry?: Subscription;

  constructor() { inject(DestroyRef).onDestroy(() => this.expiry?.unsubscribe()); }

  restore(): Promise<void> {
    if (this.restoring) return this.restoring;
    const version = this.accountVersion();
    return this.restoring = firstValueFrom(this.http.get<SessionDto>(`${API_URL}/auth/session`).pipe(timeout(SESSION_RESTORE_TIMEOUT_MS)))
      .then(dto => { this.acceptSession(dto, version); })
      .catch(() => { if (version === this.accountVersion()) this.clear(); });
  }

  async login(username: string, password: string, owner?: DestroyRef): Promise<void> {
    const version = this.accountVersion();
    const request = this.http.post<SessionDto>(`${API_URL}/auth/login`, { username, password }).pipe(timeout(15000));
    const dto = await firstValueFrom(owner ? request.pipe(takeUntilDestroyed(owner)) : request);
    if (!this.acceptSession(dto, version)) throw new Error('This sign-in request is no longer current.');
  }

  acceptSession(dto: SessionDto, expectedVersion = this.accountVersion()): boolean {
    if (expectedVersion !== this.accountVersion()) return false;
    this.expiry?.unsubscribe();
    this.session.set(dto);
    this.accountVersion.update(v => v + 1);
    const expiresAt = Date.parse(dto.expiresAt);
    if (Number.isFinite(expiresAt)) this.expiry = timer(Math.max(0, expiresAt - Date.now())).subscribe(() => this.clear());
    return true;
  }

  updateUser(user: UserDto): void {
    this.session.update(s => s?.user.id === user.id ? { ...s, user } : s);
  }

  async logout(): Promise<void> {
    const version = this.accountVersion();
    await firstValueFrom(this.http.post<void>(`${API_URL}/auth/logout`, {}));
    if (version === this.accountVersion()) this.clear();
  }

  clear(): void {
    this.expiry?.unsubscribe();
    this.session.set(null);
    this.accountVersion.update(v => v + 1);
  }
}
