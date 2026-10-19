// Author: Preston Lee

import {
  Component,
  inject,
  signal,
  computed,
  DestroyRef,
  effect,
  untracked,
} from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { form, FormField } from '@angular/forms/signals';
import { ActivatedRoute } from '@angular/router';
import { map, switchMap, of, tap, catchError } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import { NgToastService } from 'ng-angular-popup';
import { ServiceService } from '../../core/services/service.service';
import { Dashboard } from '../../core/models/dashboard.model';
import { MonitoredService } from '../../core/models/monitored-service.model';
import { DashboardService } from '../../core/services/dashboard.service';
import { SettingsService } from '../../core/services/settings.service';
import { ToastErrorService } from '../../core/services/toast-error.service';
import { ClockService } from '../../core/services/clock.service';
import { TimeAgoPipe } from '../../shared/pipes/time-ago.pipe';
import { ServiceCardComponent } from '../service/service-card.component';

const REFRESH_OPTIONS = [
  { name: ' Screen Refresh Disabled', value: 0 },
  { name: '1 Minute Refresh', value: 1000 * 60 },
  { name: '15 Minute Refresh', value: 1000 * 60 * 15 },
  { name: '1 Hour Refresh', value: 1000 * 60 * 60 },
];

interface DashboardLoadResult {
  dashboard: Dashboard;
  services: MonitoredService[];
}

interface DashboardToolbar {
  refresh: string;
  screenshots: boolean;
}

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
  standalone: true,
  imports: [TimeAgoPipe, ServiceCardComponent, FormField],
})
export class DashboardComponent {
  private readonly dashboardService = inject(DashboardService);
  private readonly serviceService = inject(ServiceService);
  private readonly route = inject(ActivatedRoute);
  private readonly toastService = inject(NgToastService);
  private readonly toastErrorService = inject(ToastErrorService);
  protected readonly settingsService = inject(SettingsService);
  protected readonly clock = inject(ClockService);
  private readonly destroyRef = inject(DestroyRef);

  readonly sort = signal<'name' | 'updated_at'>('name');
  readonly order = signal<'asc' | 'desc'>('asc');
  readonly editing = signal<Record<string, boolean>>({});
  readonly lastReload = signal(0);
  readonly loadFailed = signal(false);

  readonly toolbarDraft = signal<DashboardToolbar>({
    refresh: String(REFRESH_OPTIONS[1].value),
    screenshots: true,
  });
  readonly toolbarForm = form(this.toolbarDraft);

  readonly refreshOptions = computed(() => {
    const opts = [...REFRESH_OPTIONS];
    if (this.settingsService.settings().developer) {
      opts.unshift({
        name: '5 Second Refresh (Developers Only)',
        value: 1000 * 5,
      });
    }
    return opts;
  });

  readonly editable = () => this.settingsService.editable();

  readonly routeId = rxResource({
    stream: () =>
      this.route.paramMap.pipe(map((params) => params.get('id'))),
    defaultValue: null as string | null,
  });

  readonly dashboardData = rxResource({
    params: () => {
      const id = this.routeId.value();
      if (!id) {
        return undefined;
      }
      return {
        id,
        sort: this.sort(),
        order: this.order(),
        screenshots: this.settingsService.screenshots(),
      };
    },
    stream: ({ params }) => {
      if (!params) {
        this.loadFailed.set(false);
        return of(undefined);
      }
      this.loadFailed.set(false);
      return this.dashboardService.get(params.id).pipe(
        switchMap((dashboard) =>
          this.serviceService
            .index(
              dashboard,
              params.screenshots,
              params.sort,
              params.order
            )
            .pipe(
              map(
                (services): DashboardLoadResult => ({ dashboard, services })
              ),
              catchError((e) => {
                if (!this.toastErrorService.checkAccessDenied(e)) {
                  this.toastService.danger(
                    this.serviceService.formatErrorsTextFromResponse(e),
                    'Could not load services.'
                  );
                }
                return of({ dashboard, services: [] as MonitoredService[] });
              })
            )
        ),
        tap(() => this.lastReload.set(Date.now())),
        catchError((e) => {
          this.loadFailed.set(true);
          if (!this.toastErrorService.checkAccessDenied(e)) {
            this.toastService.danger(
              this.dashboardService.formatErrorsTextFromResponse(e),
              'Could not load dashboard.'
            );
          }
          return of(undefined);
        })
      );
    },
    defaultValue: undefined as DashboardLoadResult | undefined,
  });

  readonly loadedDashboard = () => this.dashboardData.value()?.dashboard;
  readonly services = () => this.dashboardData.value()?.services ?? [];
  readonly loading = () => this.dashboardData.isLoading();
  readonly loaded = () => this.loadedDashboard() != null;

  constructor() {
    this.toolbarDraft.set({
      refresh: String(REFRESH_OPTIONS[1].value),
      screenshots: this.settingsService.screenshots(),
    });

    effect(() => {
      const screenshots = this.toolbarDraft().screenshots;
      untracked(() => {
        if (this.settingsService.screenshots() !== screenshots) {
          this.settingsService.setScreenshots(screenshots);
        }
      });
    });

    const interval = setInterval(() => this.reloadIfNeeded(), 1000);
    this.destroyRef.onDestroy(() => clearInterval(interval));
  }

  setDisplayMode(mode: 'wide' | 'overlay'): void {
    this.settingsService.setDisplayMode(mode);
  }

  sortBy(sort: 'name' | 'updated_at'): void {
    this.sort.set(sort);
    this.order.update((o) => (o === 'asc' ? 'desc' : 'asc'));
    this.dashboardData.reload();
  }

  reloadIfNeeded(): void {
    const refreshMs = Number(this.toolbarDraft().refresh);
    if (refreshMs <= 0) return;
    if (this.lastReload() >= Date.now() - refreshMs) return;
    if (this.settingsService.editable()) return;
    this.dashboardData.reload();
  }

  reload(): void {
    this.dashboardData.reload();
  }

  create(): void {
    const d = this.loadedDashboard();
    if (!d) {
      return;
    }
    const s = new MonitoredService();
    s.name = 'Service ' + uuidv4().substring(0, 4);
    s.host = 'example.com';
    this.serviceService
      .create(d, s)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.toastService.success('Please configure it!', 'Service created.');
          this.dashboardData.reload();
          this.editing.update((e) => ({ ...e, [r.id]: true }));
        },
        error: (e) => {
          if (!this.toastErrorService.checkAccessDenied(e)) {
            this.toastService.danger(
              this.serviceService.formatErrorsTextFromResponse(e),
              'Service not created.'
            );
          }
        },
      });
  }

  onServiceUpdated(): void {
    this.dashboardData.reload();
  }

  closeServiceEditing(serviceId: string): void {
    this.editing.update((e) => ({ ...e, [serviceId]: false }));
  }

  isEditing(serviceId: string): boolean {
    return this.editing()[serviceId] ?? false;
  }

  delete(s: MonitoredService): void {
    const d = this.loadedDashboard();
    if (!d) {
      return;
    }
    this.serviceService
      .delete(d, s)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.toastService.success(
            "It's service list has also been removed.",
            'Service deleted'
          );
          this.dashboardData.reload();
        },
        error: (e) => {
          if (!this.toastErrorService.checkAccessDenied(e)) {
            this.toastService.danger(
              this.serviceService.formatErrorsTextFromResponse(e),
              'Service not deleted.'
            );
          }
        },
      });
  }
}
