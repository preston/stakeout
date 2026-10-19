// Author: Preston Lee

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { provideNgToast } from 'ng-angular-popup';
import { vi } from 'vitest';
import { DEFAULT_PREFERENCES, type SessionDto } from '@stakeout/core';
import { AuthService } from '../core/services/auth.service';
import { ProfileComponent } from './profile/profile.component';
import { UsersComponent } from './admin/users.component';
import { LoginComponent } from './auth/login.component';
import { AppComponent } from '../app.component';

const session: SessionDto = { user: { id: '1', username: 'admin', displayName: 'Admin', isActive: true, lastLoginAt: null, createdAt: '', updatedAt: '' },
  csrfToken: 'csrf', expiresAt: '', preferences: { ...DEFAULT_PREFERENCES, themePreferred: 'dark', refreshIntervalMs: 900000 } };
const microtasks = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('account screens', () => {
  let http: HttpTestingController;
  let auth: AuthService;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({ returnUrl: '/profile' }) } } },
      provideNgToast()] });
    http = TestBed.inject(HttpTestingController); auth = TestBed.inject(AuthService);
  });
  afterEach(() => { http.verify(); vi.restoreAllMocks(); });

  it('shows administration and editing controls only for signed-in users', () => {
    const fixture = TestBed.createComponent(AppComponent); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('#nav-sign-in')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('#nav-administration')).toBeNull();
    auth.acceptSession(session); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('#nav-administration')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('#nav-sign-in')).toBeNull();
    expect((fixture.nativeElement.querySelector('#nav-edit') as HTMLInputElement).checked).toBe(false);
    fixture.nativeElement.querySelector('#nav-account').click(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('#nav-profile').getAttribute('href')).toBe('/profile');
  });

  it('hydrates profile controls and saves numeric refresh preferences to the account', async () => {
    auth.acceptSession(session);
    const fixture = TestBed.createComponent(ProfileComponent); fixture.detectChanges();
    const component = fixture.componentInstance;
    expect(component.draft().themePreferred).toBe('dark');
    const refresh = fixture.nativeElement.querySelector('#profile-refresh') as HTMLSelectElement;
    expect(refresh.value).toBe('900000');
    refresh.value = '3600000'; refresh.dispatchEvent(new Event('change'));
    expect(component.draft().refreshIntervalMs).toBe(3600000);
    const saving = component.save(new Event('submit'));
    http.expectOne('/users/me').flush(session.user); await microtasks(); await microtasks();
    const preferences = http.expectOne('/users/me/settings'); expect(preferences.request.body.refreshIntervalMs).toBe(3600000);
    preferences.flush({ ...session.preferences, refreshIntervalMs: 3600000 }); await saving;
    expect(component.message()).toBe('Profile saved.');
  });

  it('does not apply an old profile response or save its preferences to a different account', async () => {
    auth.acceptSession(session);
    const fixture = TestBed.createComponent(ProfileComponent); fixture.detectChanges();
    const component = fixture.componentInstance;
    const saving = component.save(new Event('submit'));
    const identity = http.expectOne('/users/me');
    const next = { ...session, user: { ...session.user, id: '2', username: 'other' }, preferences: { ...DEFAULT_PREFERENCES } };
    auth.acceptSession(next);
    identity.flush(session.user); await microtasks(); await microtasks();
    const leaked = http.match('/users/me/settings');
    for (const request of leaked) request.flush(next.preferences);
    await saving;
    expect(auth.session()?.user.id).toBe('2');
    expect(leaked.length).toBe(0);
    expect(component.message()).toBe('');
  });

  it('does not restore a session from a password response after leaving the profile and signing out', async () => {
    auth.acceptSession(session);
    const fixture = TestBed.createComponent(ProfileComponent); fixture.detectChanges();
    const component = fixture.componentInstance;
    component.passwords.set({ currentPassword: 'initial-password-123', password: 'replacement-password-123', confirmation: 'replacement-password-123' });
    const changing = component.changePassword(new Event('submit'));
    const request = http.expectOne('/users/me/password');
    fixture.destroy(); auth.clear();
    if (!request.cancelled) request.flush(session);
    await changing;
    expect(auth.isAuthenticated()).toBe(false);
  });

  it('creates users through the list/detail editor and displays validation failures', async () => {
    auth.acceptSession(session);
    const fixture = TestBed.createComponent(UsersComponent); fixture.detectChanges();
    http.expectOne('/admin/users').flush([session.user]); await microtasks(); fixture.detectChanges();
    fixture.nativeElement.querySelector('#admin-create-user').click(); fixture.detectChanges();
    const component = fixture.componentInstance;
    component.draft.set({ username: 'new', displayName: 'New', isActive: true, password: 'new-password-123', confirmation: 'new-password-123' });
    const saving = component.save(new Event('submit'));
    const created = { ...session.user, id: '2', username: 'new', displayName: 'New' };
    const request = http.expectOne('/admin/users'); expect(request.request.method).toBe('POST');
    expect(request.request.body.confirmation).toBeUndefined(); request.flush(created); await microtasks();
    http.expectOne('/admin/users').flush([session.user, created]); await saving;
    expect(component.selectedId()).toBe('2'); expect(component.draft().password).toBe('');
    const updating = component.save(new Event('submit'));
    http.expectOne('/admin/users/2').flush({ username: ['has already been taken'] }, { status: 422, statusText: 'Invalid' }); await updating;
    expect(component.error()).toContain('has already been taken');
  });

  it('does not sign out a newer session when an old administrative password reset completes', async () => {
    auth.acceptSession(session);
    const fixture = TestBed.createComponent(UsersComponent); fixture.detectChanges();
    http.expectOne('/admin/users').flush([session.user]); await microtasks();
    const component = fixture.componentInstance;
    component.select(session.user);
    component.draft.update(d => ({ ...d, password: 'replacement-password-123', confirmation: 'replacement-password-123' }));
    const resetting = component.resetPassword(new Event('submit'));
    const request = http.expectOne('/admin/users/1/password');
    auth.acceptSession({ ...session, csrfToken: 'new-session' });
    request.flush(null); await resetting;
    expect(auth.session()?.csrfToken).toBe('new-session');
    expect(component.message()).toBe('');
  });

  it('cancels a login response when navigation closes the dialog before sign-in completes', async () => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn() });
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const fixture = TestBed.createComponent(LoginComponent); fixture.detectChanges();
    const component = fixture.componentInstance;
    component.draft.set({ username: 'admin', password: 'initial-password-123' });
    const signingIn = component.submit(new Event('submit'));
    const request = http.expectOne('/auth/login');
    fixture.destroy();
    if (!request.cancelled) request.flush(session);
    await signingIn;
    expect(request.cancelled).toBe(true);
    expect(auth.isAuthenticated()).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('opens a login dialog and resumes the protected destination after signing in', async () => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.setAttribute('open', ''); }) });
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const fixture = TestBed.createComponent(LoginComponent); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('dialog').open).toBe(true);
    const component = fixture.componentInstance;
    component.draft.set({ username: 'admin', password: 'initial-password-123' });
    const signingIn = component.submit(new Event('submit'));
    await component.submit(new Event('submit'));
    http.expectOne('/auth/login').flush(session); await signingIn;
    expect(navigate).toHaveBeenCalledWith('/profile'); expect(component.draft().password).toBe('');
  });
});
