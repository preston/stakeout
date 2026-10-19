// Author: Preston Lee

import { Component, inject, signal, computed, effect, untracked } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive, Router, NavigationEnd } from '@angular/router';
import { NgToastComponent } from 'ng-angular-popup';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { AuthService } from './core/services/auth.service';
import { SettingsService } from './core/services/settings.service';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, NgToastComponent],
})
export class AppComponent {
  protected readonly settingsService = inject(SettingsService);
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  readonly accountMenu = signal(false);
  readonly navExpanded = signal(false);
  readonly logoutError = signal('');
  readonly title = (window as unknown as { STAKEOUT_UI_TITLE?: string }).STAKEOUT_UI_TITLE ?? 'Stakeout';
  readonly currentUrl = toSignal(this.router.events.pipe(filter(e => e instanceof NavigationEnd), map(e => e.urlAfterRedirects)), { initialValue: this.router.url });
  readonly dashboardRoute = computed(() => this.currentUrl() === '/' || this.currentUrl().startsWith('/dashboards/'));

  constructor() {
    effect(() => {
      if (!this.auth.isAuthenticated() && /^\/(admin|profile)(\/|$)/.test(this.currentUrl())) {
        untracked(() => { void this.router.navigateByUrl('/'); });
      }
    });
  }

  async logout(): Promise<void> {
    this.logoutError.set('');
    try { await this.auth.logout(); this.accountMenu.set(false); await this.router.navigateByUrl('/'); }
    catch { this.logoutError.set('Could not sign out. Please try again.'); }
  }
}
