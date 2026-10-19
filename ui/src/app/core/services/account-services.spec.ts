// Author: Preston Lee

import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, Router, type ActivatedRouteSnapshot, type RouterStateSnapshot, type UrlTree } from '@angular/router';
import { vi } from 'vitest';
import { NgToastService } from 'ng-angular-popup';
import { DEFAULT_PREFERENCES, type SessionDto, type UserPreferences } from '@stakeout/core';
import { AuthService, localReturnUrl } from './auth.service';
import { authInterceptor } from './auth.interceptor';
import { authenticatedGuard } from './auth.guard';
import { SettingsService } from './settings.service';

function session(id: string, preferences: Partial<UserPreferences> = {}): SessionDto {
  return { user: { id, username: id, displayName: id, isActive: true, createdAt: '', updatedAt: '', lastLoginAt: null },
    preferences: { ...DEFAULT_PREFERENCES, ...preferences }, csrfToken: id, expiresAt: '' };
}
const microtasks = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('account state and persistence', () => {
  let auth: AuthService;
  let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(withInterceptors([authInterceptor])),
      provideHttpClientTesting(), { provide: NgToastService, useValue: { danger: vi.fn() } }] });
    auth = TestBed.inject(AuthService); http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('restores the cookie session once and sends CSRF only to API mutations', async () => {
    const restored = auth.restore();
    const request = http.expectOne('/auth/session');
    expect(request.request.withCredentials).toBe(true);
    expect(request.request.headers.get('Accept')).toBe('application/json');
    request.flush(session('a')); await restored; await auth.restore();
    expect(auth.isAuthenticated()).toBe(true);
    const client = TestBed.inject(HttpClient);
    client.patch('/users/me', { displayName: 'A' }).subscribe();
    const patch = http.expectOne('/users/me'); expect(patch.request.headers.get('X-CSRF-Token')).toBe('a'); patch.flush({});
    client.get('https://external.example/data').subscribe();
    const external = http.expectOne('https://external.example/data');
    expect(external.request.withCredentials).toBe(false); expect(external.request.headers.has('X-CSRF-Token')).toBe(false); external.flush({});
  });

  it('finishes startup if the session endpoint never responds', async () => {
    vi.useFakeTimers();
    try {
      let finished = false;
      const restored = auth.restore().then(() => { finished = true; });
      const request = http.expectOne('/auth/session');
      await vi.advanceTimersByTimeAsync(8001);
      const timedOut = finished;
      if (!request.cancelled) request.flush({}, { status: 503, statusText: 'Unavailable' });
      await restored;
      expect(timedOut).toBe(true);
      expect(auth.isAuthenticated()).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('ignores session restoration and logout responses belonging to an earlier account', async () => {
    const restored = auth.restore();
    const oldRestore = http.expectOne('/auth/session');
    auth.acceptSession(session('b'));
    oldRestore.flush(session('a')); await restored;
    expect(auth.session()?.user.id).toBe('b');
    const signingOut = auth.logout(); const oldLogout = http.expectOne('/auth/logout');
    auth.acceptSession(session('c')); oldLogout.flush(null); await signingOut;
    expect(auth.session()?.user.id).toBe('c');
    auth.updateUser(session('a').user); expect(auth.session()?.user.id).toBe('c');
  });

  it('resets a failed session while retaining a later account when an old response arrives', () => {
    auth.acceptSession(session('a'));
    const client = TestBed.inject(HttpClient);
    client.get('/users/me').subscribe({ error: () => {} });
    const stale = http.expectOne('/users/me');
    auth.acceptSession(session('b')); stale.flush({}, { status: 401, statusText: 'Unauthorized' });
    expect(auth.session()?.user.id).toBe('b');
    client.get('/users/me').subscribe({ error: () => {} });
    http.expectOne('/users/me').flush({}, { status: 401, statusText: 'Unauthorized' });
    expect(auth.isAuthenticated()).toBe(false);
  });

  it('keeps guest preferences in memory and removes only Stakeout legacy storage', async () => {
    localStorage.setItem('unrelated', 'keep'); localStorage.setItem('stakeout_settings', '{"cds_password":"old-secret"}');
    sessionStorage.setItem('stakeout_editable', 'true');
    const settings = TestBed.inject(SettingsService);
    await settings.savePreferences({ displayMode: 'wide', screenshots: false });
    settings.setEditable(true);
    expect(settings.editable()).toBe(false); expect(settings.displayMode()).toBe('wide');
    expect(localStorage.getItem('stakeout_settings')).toBeNull(); expect(sessionStorage.getItem('stakeout_editable')).toBeNull();
    expect(localStorage.getItem('unrelated')).toBe('keep');
    auth.acceptSession(session('a', { themePreferred: 'dark' }));
    expect(settings.settings().themePreferred).toBe('dark'); expect(settings.displayMode()).toBe('overlay');
    TestBed.tick(); settings.setEditable(true); expect(settings.editable()).toBe(true);
    auth.clear(); expect(settings.editable()).toBe(false); expect(settings.settings()).toEqual(DEFAULT_PREFERENCES);
  });

  it('serializes autosaves and retains later optimistic changes while earlier saves complete', async () => {
    auth.acceptSession(session('a'));
    const settings = TestBed.inject(SettingsService);
    const one = settings.savePreferences({ screenshots: false });
    const two = settings.savePreferences({ displayMode: 'wide' });
    await microtasks();
    const first = http.expectOne('/users/me/settings'); expect(first.request.body).toEqual({ screenshots: false });
    expect(settings.displayMode()).toBe('wide');
    first.flush({ ...DEFAULT_PREFERENCES, screenshots: false }); await one; await microtasks();
    expect(settings.displayMode()).toBe('wide');
    const second = http.expectOne('/users/me/settings'); expect(second.request.body).toEqual({ displayMode: 'wide' });
    second.flush({ ...DEFAULT_PREFERENCES, screenshots: false, displayMode: 'wide' }); await two;
    expect(settings.settings().screenshots).toBe(false); expect(settings.displayMode()).toBe('wide');
  });

  it('discards in-flight responses and queued writes belonging to a previous account', async () => {
    auth.acceptSession(session('a'));
    const settings = TestBed.inject(SettingsService);
    const one = settings.savePreferences({ themePreferred: 'dark' });
    const queued = settings.savePreferences({ displayMode: 'wide' });
    await microtasks(); const first = http.expectOne('/users/me/settings');
    auth.acceptSession(session('b'));
    expect(settings.settings()).toEqual(DEFAULT_PREFERENCES);
    first.flush({ ...DEFAULT_PREFERENCES, themePreferred: 'dark' });
    await one; await queued; TestBed.tick();
    expect(settings.settings()).toEqual(DEFAULT_PREFERENCES);
    http.expectNone('/users/me/settings');
  });

  it('rolls back failed saves and normalizes the developer refresh interval', async () => {
    auth.acceptSession(session('a', { developer: true, refreshIntervalMs: 5000 }));
    const settings = TestBed.inject(SettingsService);
    const saved = settings.savePreferences({ developer: false }); await microtasks();
    const request = http.expectOne('/users/me/settings');
    expect(request.request.body).toEqual({ developer: false, refreshIntervalMs: 60000 });
    request.flush({ ...DEFAULT_PREFERENCES }); await saved;
    const failed = settings.savePreferences({ screenshots: false });
    const rejection = expect(failed).rejects.toBeTruthy(); await microtasks();
    http.expectOne('/users/me/settings').flush({}, { status: 500, statusText: 'Error' });
    await rejection; expect(settings.screenshots()).toBe(true);
  });

  it('clears expired sessions even when public dashboard reads continue succeeding', () => {
    vi.useFakeTimers();
    try {
      auth.acceptSession({ ...session('a', { themePreferred: 'dark' }), expiresAt: new Date(Date.now() + 1000).toISOString() });
      const settings = TestBed.inject(SettingsService);
      settings.setEditable(true);
      vi.advanceTimersByTime(1001);
      expect(auth.isAuthenticated()).toBe(false);
      expect(settings.editable()).toBe(false);
      expect(settings.settings()).toEqual(DEFAULT_PREFERENCES);
    } finally { vi.useRealTimers(); }
  });

  it('guards personal routes and preserves the destination for login', async () => {
    const result = TestBed.runInInjectionContext(() => authenticatedGuard({} as ActivatedRouteSnapshot, { url: '/profile' } as RouterStateSnapshot));
    http.expectOne('/auth/session').flush({}, { status: 401, statusText: 'Unauthorized' });
    expect(TestBed.inject(Router).serializeUrl(await result as UrlTree)).toBe('/login?returnUrl=%2Fprofile');
    expect(localReturnUrl('//evil.example')).toBe('/'); expect(localReturnUrl('/\\evil')).toBe('/');
    expect(localReturnUrl('/login?returnUrl=/profile')).toBe('/'); expect(localReturnUrl('/admin/users')).toBe('/admin/users');
  });
});
