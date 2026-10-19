// Author: Preston Lee

import {
  Component,
  inject,
  signal,
  computed,
  DestroyRef,
  effect,
  untracked,
  viewChild,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { HistoryService } from '../../core/services/history.service';
import type { HistoryServiceSummary } from '../../core/models/history.model';
import { HistoryPanelComponent, type HistoryView } from '../history/history-panel.component';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
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
import { ScreenshotViewerComponent } from '../service/screenshot-viewer.component';

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


@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
  standalone: true,
  imports: [TimeAgoPipe, ServiceCardComponent, ScreenshotViewerComponent, HistoryPanelComponent],
})
export class DashboardComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly historyService = inject(HistoryService);
  private readonly document = inject(DOCUMENT);
  private readonly historyPanel = viewChild(HistoryPanelComponent);
  readonly historyView = signal<HistoryView>((this.route.snapshot?.queryParamMap?.get('view') as HistoryView) ?? 'overview');
  readonly historyRows = signal<HistoryServiceSummary[]>([]);
  readonly visibleServiceIds = signal<string[] | null>(null);
  private lastDemandAt = 0;
  private demandDashboardId = '';
  private demandInFlight = false;
  private readonly pageVisible = signal(this.document.visibilityState !== 'hidden');
  private readonly dashboardService = inject(DashboardService);
  private readonly serviceService = inject(ServiceService);
  private readonly toastService = inject(NgToastService);
  private readonly toastErrorService = inject(ToastErrorService);
  protected readonly settingsService = inject(SettingsService);
  protected readonly clock = inject(ClockService);
  private readonly destroyRef = inject(DestroyRef);

  readonly sort = computed(() => this.settingsService.settings().serviceSort === 'updatedAt' ? 'updated_at' : 'name');
  readonly order = computed(() => this.settingsService.settings().serviceOrder);
  readonly editing = signal<Record<string, boolean>>({});
  readonly lastReload = signal(0);
  readonly loadFailed = signal(false);
  private readonly lastSuccessfulData = signal<DashboardLoadResult | undefined>(undefined);
  readonly selectedServiceId = signal<string | null>(null);

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
                const previous = this.lastSuccessfulData();
                return of({ dashboard, services: previous?.dashboard.id === dashboard.id ? previous.services : [] });
              })
            )
        ),
        tap((data) => {
          this.lastSuccessfulData.set(data);
          this.lastReload.set(Date.now());
        }),
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

  private readonly currentData = computed(() => this.dashboardData.value() ??
    (this.lastSuccessfulData()?.dashboard.id === this.routeId.value() ? this.lastSuccessfulData() : undefined));
  readonly loadedDashboard = () => this.currentData()?.dashboard;
  readonly services = () => this.currentData()?.services ?? [];
  readonly visibleServices = computed(() => {
    const ids = this.visibleServiceIds();
    return ids ? this.services().filter(service => ids.includes(service.id)) : this.services().slice(0, 100);
  });
  readonly selectedService = computed(() => this.settingsService.screenshots()
    ? this.services().find(service => service.id === this.selectedServiceId()) ?? null : null);
  readonly loading = () => this.dashboardData.isLoading();
  readonly loaded = () => this.loadedDashboard() != null;

  constructor() {
    effect(() => {
      if (!this.settingsService.editable()) untracked(() => this.editing.set({}));
    });
    const onVisibility = () => { this.pageVisible.set(this.document.visibilityState !== 'hidden'); this.sendScreenshotDemand(); };
    this.document.addEventListener('visibilitychange', onVisibility);
    this.destroyRef.onDestroy(() => this.document.removeEventListener('visibilitychange', onVisibility));
    effect(() => {
      this.loadedDashboard(); this.historyView(); this.pageVisible(); this.settingsService.screenshots(); this.settingsService.settings().refreshIntervalMs;
      untracked(() => this.sendScreenshotDemand());
    });
    const interval = setInterval(() => { this.reloadIfNeeded(); this.sendScreenshotDemand(); }, 1000);
    this.destroyRef.onDestroy(() => clearInterval(interval));
  }

  historyFor(serviceId: string): HistoryServiceSummary | undefined { return this.historyRows().find(row => row.service_id === serviceId); }

  openHistory(serviceId: string): void { this.historyPanel()?.openService(serviceId); }

  sendScreenshotDemand(): void {
    const dashboard = this.loadedDashboard();
    if (!dashboard || dashboard.screenshots_enabled === false || !this.settingsService.screenshots() ||
      this.settingsService.settings().refreshIntervalMs <= 0 || this.historyView() !== 'overview' || !this.pageVisible() ||
      !this.visibleServices().some(service => service.http_preview && (service.http || service.https))) return;
    const now = Date.now();
    if (this.demandInFlight || (this.demandDashboardId === dashboard.id && now - this.lastDemandAt < 30000)) return;
    this.demandInFlight = true;
    this.lastDemandAt = now; this.demandDashboardId = dashboard.id;
    this.historyService.screenshotDemand(dashboard.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.demandInFlight = false; }, error: () => { this.demandInFlight = false; },
    });
  }

  setRefresh(event: Event): void {
    this.settingsService.change({ refreshIntervalMs: Number((event.target as HTMLSelectElement).value) });
  }

  setScreenshots(event: Event): void {
    this.settingsService.setScreenshots((event.target as HTMLInputElement).checked);
  }

  setDisplayMode(mode: 'wide' | 'overlay'): void {
    this.settingsService.setDisplayMode(mode);
  }

  sortBy(sort: 'name' | 'updated_at'): void {
    this.settingsService.change({ serviceSort: sort === 'updated_at' ? 'updatedAt' : 'name', serviceOrder: this.order() === 'asc' ? 'desc' : 'asc' });
    this.historyPanel()?.setOverviewSort(sort === 'updated_at' ? 'latest_check_at' : 'name', this.order());
    this.dashboardData.reload();
  }

  reloadIfNeeded(): void {
    const refreshMs = this.settingsService.settings().refreshIntervalMs;
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
