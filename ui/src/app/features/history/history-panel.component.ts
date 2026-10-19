import { Component, DestroyRef, computed, effect, inject, input, output, signal, untracked, viewChild, ElementRef } from '@angular/core';
import { DatePipe, DecimalPipe, DOCUMENT } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, of } from 'rxjs';
import type { AvailabilityState, DashboardHistoryResponse, DashboardEventsResponse, HistoryBucket, HistoryEvent, HistoryQuery, HistoryServiceSummary, ServiceHistoryResponse } from '../../core/models/history.model';
import { HistoryService } from '../../core/services/history.service';
import { DashboardService } from '../../core/services/dashboard.service';
import { ClockService } from '../../core/services/clock.service';
import { SettingsService } from '../../core/services/settings.service';
import { Dashboard } from '../../core/models/dashboard.model';
import { MonitoredService } from '../../core/models/monitored-service.model';
import { HistoryTimelineComponent } from './history-timeline.component';

export type HistoryView = 'overview' | 'timeline' | 'services' | 'events';
export function durationLabel(ms: number): string {
  if (ms < 1000) return '0s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h`;
}
function localInput(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}
@Component({
  selector: 'app-history-panel', standalone: true,
  imports: [DatePipe, DecimalPipe, FormsModule, HistoryTimelineComponent],
  templateUrl: './history-panel.component.html', styleUrl: './history-panel.component.scss',
})
export class HistoryPanelComponent {
  readonly dashboard = input.required<Dashboard>();
  readonly services = input<MonitoredService[]>([]);
  readonly refreshToken = input(0);
  readonly viewChanged = output<HistoryView>();
  readonly rowsChanged = output<HistoryServiceSummary[]>();
  readonly serviceIdsChanged = output<string[]>();
  private readonly historyService = inject(HistoryService);
  private readonly dashboardService = inject(DashboardService);
  private readonly settings = inject(SettingsService);
  private readonly clock = inject(ClockService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  private readonly detailPane = viewChild<ElementRef<HTMLElement>>('detailPane');
  private previouslyFocused: HTMLElement | null = null;
  private focusedDetailId: string | null = null;
  readonly editable = this.settings.editable;
  readonly views: HistoryView[] = ['overview', 'timeline', 'services', 'events'];
  readonly states: AvailabilityState[] = ['up', 'degraded', 'down', 'unknown', 'paused'];
  readonly timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  readonly view = signal<HistoryView>('overview');
  readonly range = signal('24h');
  readonly rangeEnd = signal(Date.now());
  readonly customFrom = signal(localInput(new Date(Date.now() - 86400000)));
  readonly customTo = signal(localInput(new Date()));
  readonly serviceFilter = signal('');
  readonly stateFilter = signal('');
  readonly page = signal(1);
  readonly detailPage = signal(1);
  readonly detailOutagePage = signal(1);
  readonly detailId = signal<string | null>(null);
  readonly eventId = signal<string | null>(null);
  readonly selectedPeriod = signal<HistoryBucket | null>(null);
  readonly sort = signal<NonNullable<HistoryQuery['sort']>>('name');
  readonly order = signal<'asc' | 'desc'>('asc');
  readonly historyError = signal(false);
  readonly eventsError = signal(false);
  readonly detailError = signal(false);
  readonly saving = signal(false);
  readonly settingsMessage = signal('');
  readonly draft = signal(new Dashboard());
  readonly duration = durationLabel;
  readonly newDate = (value: string) => new Date(value);
  readonly rangeError = computed(() => {
    if (this.range() !== 'custom') return '';
    const from = Date.parse(this.customFrom()); const to = Date.parse(this.customTo());
    return !Number.isFinite(from) || !Number.isFinite(to) || from >= to ? 'Choose a start date before the end date.'
      : to > Date.now() ? 'Choose an end date in the past or present.' : '';
  });
  readonly query = computed<HistoryQuery>(() => {
    const end = this.range() === 'custom' ? Date.parse(this.customTo()) : this.rangeEnd();
    const hours = ({ '24h': 24, '7d': 168, '30d': 720, '90d': 2160 } as Record<string, number>)[this.range()] ?? 24;
    const start = this.range() === 'custom' ? Date.parse(this.customFrom()) : end - hours * 3600000;
    return { from: new Date(Number.isFinite(start) ? start : Date.now() - 86400000).toISOString(),
      to: new Date(Number.isFinite(end) ? end : Date.now()).toISOString(),
      service_id: this.serviceFilter() || undefined, state: (this.stateFilter() || undefined) as AvailabilityState | undefined,
      page: this.page(), limit: 100, sort: this.sort(), order: this.order() };
  });
  readonly history = rxResource({
    params: () => this.rangeError() ? undefined : { id: this.dashboard().id, query: this.query(), refresh: this.refreshToken() },
    stream: ({ params }) => {
      this.historyError.set(false);
      return this.historyService.history(params.id, params.query).pipe(catchError(() => { this.historyError.set(true); return of(undefined); }));
    }, defaultValue: undefined as DashboardHistoryResponse | undefined,
  });
  readonly events = rxResource({
    params: () => this.view() === 'events' && !this.rangeError() ? { id: this.dashboard().id, query: this.query(), refresh: this.refreshToken() } : undefined,
    stream: ({ params }) => {
      this.eventsError.set(false);
      return this.historyService.events(params.id, params.query).pipe(catchError(() => { this.eventsError.set(true); return of(undefined); }));
    }, defaultValue: undefined as DashboardEventsResponse | undefined,
  });
  readonly detail = rxResource({
    params: () => this.detailId() && !this.rangeError() ? { id: this.dashboard().id, serviceId: this.detailId()!, query: { ...this.query(), ...(this.selectedPeriod() ? { from: this.selectedPeriod()!.from, to: this.selectedPeriod()!.to } : {}), page: this.detailPage(), outage_page: this.detailOutagePage(), event_id: this.eventId() ?? undefined, state: undefined }, refresh: this.refreshToken() } : undefined,
    stream: ({ params }) => {
      this.detailError.set(false);
      return this.historyService.service(params.id, params.serviceId, params.query).pipe(catchError(() => { this.detailError.set(true); return of(undefined); }));
    }, defaultValue: undefined as ServiceHistoryResponse | undefined,
  });
  readonly pagination = computed(() => this.view() === 'events' ? this.events.value()?.pagination : this.history.value()?.pagination);
  readonly historyStale = computed(() => {
    const generated = this.history.value()?.generated_at;
    return !!generated && this.clock.now() - Date.parse(generated) > (this.dashboard().check_interval_seconds ?? 60) * 3000;
  });
  readonly counts = computed(() => {
    const currentCounts = !this.historyStale() ? this.history.value()?.current_counts : undefined;
    if (currentCounts) return Object.entries(currentCounts).filter(([, count]) => count > 0).map(([state, count]) => ({ state, count }));
    const rows = this.history.value()?.services ?? [];
    const counts: Record<string, number> = {};
    for (const service of this.filteredServices()) {
      const row = rows.find(item => item.service_id === service.id);
      const state = !this.historyStale() && row ? row.current_state : this.currentState(service);
      counts[state] = (counts[state] ?? 0) + 1;
    }
    return Object.entries(counts).map(([state, count]) => ({ state, count }));
  });
  readonly filteredServices = computed(() => this.services().filter(service =>
    (!this.serviceFilter() || this.serviceFilter().split(',').includes(service.id)) &&
    (!this.stateFilter() || this.currentState(service) === this.stateFilter())));
  readonly activeEvent = computed(() => this.eventId() ? this.detail.value()?.selected_event : null);
  readonly exportUrl = computed(() => this.historyService.exportUrl(this.dashboard().id, this.query(), this.view() === 'events' ? 'events' : 'services'));
  readonly chart = computed(() => {
    const buckets = this.detail.value()?.performance_buckets ?? [];
    const max = Math.max(1, ...buckets.flatMap(bucket => [bucket.http.max_ms ?? 0, bucket.https.max_ms ?? 0]));
    const from = Date.parse(this.detail.value()?.from ?? '') || 0;
    const duration = Math.max(1, (Date.parse(this.detail.value()?.to ?? '') || 0) - from);
    const points = (protocol: 'http' | 'https', metric: 'average_ms' | 'min_ms' | 'max_ms') => {
      const segments: string[] = []; let segment: string[] = []; let previousEnd: number | null = null;
      const flush = () => { if (segment.length) segments.push(segment.join(' ')); segment = []; };
      for (const bucket of buckets) {
        const start = Date.parse(bucket.from); const end = Date.parse(bucket.to);
        if (previousEnd !== null && start > previousEnd) flush();
        const value = bucket[protocol][metric];
        if (value === null) flush();
        else {
          const x = Math.max(0, Math.min(600, ((start + end) / 2 - from) / duration * 600));
          segment.push(`${x},${120 - value / max * 110}`);
        }
        previousEnd = end;
      }
      flush(); return segments;
    };
    const http = points('http', 'average_ms'); const https = points('https', 'average_ms');
    const dots = (segments: string[]) => segments.flatMap(segment => segment.split(' ').map(point => { const [x, y] = point.split(','); return { x, y }; }));
    return { max, http, https, httpDots: dots(http), httpsDots: dots(https),
      httpMin: points('http', 'min_ms'), httpMax: points('http', 'max_ms'), httpsMin: points('https', 'min_ms'), httpsMax: points('https', 'max_ms'), hasData: buckets.some(bucket => bucket.http.response_count || bucket.https.response_count) };
  });

  constructor() {
    this.route.queryParamMap?.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(params => {
      this.view.set(this.views.includes(params.get('view') as HistoryView) ? params.get('view') as HistoryView : 'overview');
      const range = params.get('range');
      this.range.set(['24h', '7d', '30d', '90d', 'custom'].includes(range ?? '') ? range! : '24h');
      for (const [key, target] of [['from', this.customFrom], ['to', this.customTo]] as const) {
        const value = params.get(key);
        if (value && Number.isFinite(Date.parse(value))) target.set(localInput(new Date(value)));
      }
      this.serviceFilter.set(params.get('service_id') ?? '');
      this.stateFilter.set(this.states.includes(params.get('state') as AvailabilityState) ? params.get('state')! : '');
      this.detailId.set(params.get('detail'));
      this.eventId.set(params.get('event'));
      this.page.set(Math.max(1, Number(params.get('page')) || 1));
      this.sort.set(['name', 'state', 'uptime', 'downtime', 'outage_count', 'latest_check_at', 'response_ms'].includes(params.get('sort') ?? '') ? params.get('sort') as NonNullable<HistoryQuery['sort']> : 'name'); this.order.set(params.get('order') === 'desc' ? 'desc' : 'asc');
    });
    effect(() => {
      const pane = this.detailPane(); const id = this.detailId();
      if (pane && id && this.focusedDetailId !== id) {
        this.focusedDetailId = id; pane.nativeElement.focus(); pane.nativeElement.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      }
    });
    effect(() => this.viewChanged.emit(this.view()));
    effect(() => this.rowsChanged.emit(this.history.value()?.services ?? []));
    effect(() => this.serviceIdsChanged.emit(this.history.value()?.services.map(service => service.service_id) ?? this.filteredServices().slice(0, 100).map(service => service.id)));
    effect(() => { const dashboard = this.dashboard(); untracked(() => this.draft.set({ ...new Dashboard(), ...dashboard })); });
    effect(() => { this.refreshToken(); untracked(() => { if (this.range() !== 'custom') this.rangeEnd.set(Date.now()); }); });
  }

  currentState(service: MonitoredService): string {
    if (this.dashboard().monitoring_enabled === false) return 'paused';
    if (!service.http && !service.https) return 'unknown';
    if (!service.checked_at || Date.parse(service.checked_at) < this.clock.now() - (this.dashboard().check_interval_seconds ?? 60) * 3000) return 'unknown';
    const enabled = [service.http ? service.http_path_last === true : null, service.https ? service.https_path_last === true : null].filter(value => value !== null);
    return enabled.every(Boolean) ? 'up' : enabled.some(Boolean) ? 'degraded' : 'down';
  }
  changeView(view: HistoryView): void { this.view.set(view); this.page.set(1); this.syncUrl(); }
  setFilter(field: 'range' | 'service' | 'state' | 'from' | 'to', value: string): void {
    ({ range: this.range, service: this.serviceFilter, state: this.stateFilter, from: this.customFrom, to: this.customTo })[field].set(value);
    if (field === 'range') this.rangeEnd.set(Date.now());
    this.page.set(1); this.detailPage.set(1); this.detailOutagePage.set(1); this.selectedPeriod.set(null); this.syncUrl();
  }
  setPage(page: number): void { this.page.set(page); this.syncUrl(); }
  sortBy(sort: NonNullable<HistoryQuery['sort']>): void {
    this.order.set(this.sort() === sort && this.order() === 'asc' ? 'desc' : 'asc'); this.sort.set(sort); this.page.set(1); this.syncUrl();
  }
  setOverviewSort(sort: 'name' | 'latest_check_at', order: 'asc' | 'desc'): void {
    this.sort.set(sort); this.order.set(order); this.page.set(1); this.syncUrl();
  }
  openService(id: string, period?: HistoryBucket): void {
    this.previouslyFocused = this.document.activeElement instanceof HTMLElement ? this.document.activeElement : null;
    this.detailId.set(id); this.detailPage.set(1); this.detailOutagePage.set(1); this.eventId.set(null); this.selectedPeriod.set(period ?? null); this.syncUrl();
  }
  openEvent(event: HistoryEvent): void {
    this.previouslyFocused = this.document.activeElement instanceof HTMLElement ? this.document.activeElement : null;
    this.detailId.set(event.service_id); this.detailPage.set(1); this.detailOutagePage.set(1);
    this.eventId.set(event.id); this.selectedPeriod.set(null); this.syncUrl();
  }
  clearEventSelection(): void { this.eventId.set(null); this.detailPage.set(1); this.syncUrl(); }
  selectDetailPeriod(period: HistoryBucket): void {
    this.eventId.set(null); this.detailPage.set(1); this.detailOutagePage.set(1); this.selectedPeriod.set(period); this.syncUrl();
  }
  closeDetail(): void { this.focusedDetailId = null; this.previouslyFocused?.focus(); this.detailId.set(null); this.eventId.set(null); this.selectedPeriod.set(null); this.syncUrl(); }
  private syncUrl(): void {
    const query = this.query();
    void this.router.navigate([], { relativeTo: this.route, queryParamsHandling: 'merge', replaceUrl: true,
      queryParams: { view: this.view() === 'overview' ? null : this.view(), range: this.range() === '24h' ? null : this.range(),
        from: this.range() === 'custom' && !this.rangeError() ? query.from : null, to: this.range() === 'custom' && !this.rangeError() ? query.to : null,
        service_id: this.serviceFilter() || null, state: this.stateFilter() || null, page: this.page() === 1 ? null : this.page(),
        detail: this.detailId(), event: this.eventId(), sort: this.sort() === 'name' ? null : this.sort(), order: this.order() === 'asc' ? null : this.order() } });
  }
  intervalMatchesSelection(from: string, to: string): boolean {
    if (this.eventId()) return !!this.activeEvent();
    const selected = this.selectedPeriod();
    return selected !== null && Date.parse(from) < Date.parse(selected.to) && Date.parse(to) > Date.parse(selected.from);
  }
  retry(): void { this.history.reload(); this.events.reload(); this.detail.reload(); }
  updateDraft(field: keyof Dashboard, value: string | boolean): void {
    const parsed = typeof value === 'boolean' ? value : value === '' ? null : Number(value);
    this.draft.update(draft => ({ ...draft, [field]: parsed }));
    this.settingsMessage.set('');
  }
  saveSettings(event: Event): void {
    event.preventDefault();
    if (!this.editable() || this.saving()) return;
    const draft = this.draft();
    for (const key of ['check_interval_seconds', 'screenshot_interval_seconds', 'hourly_retention_days', 'daily_retention_days', 'availability_retention_days'] as const) {
      const value = draft[key];
      if ((value === null && !key.endsWith('retention_days')) || (value !== null && (!Number.isInteger(value) || value <= 0))) {
        this.settingsMessage.set('Intervals and retention days must be positive whole numbers. Leave retention blank to keep indefinitely.'); return;
      }
    }
    this.saving.set(true);
    this.dashboardService.update(draft).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: saved => { this.saving.set(false); this.draft.set(saved); this.settingsMessage.set('Dashboard monitoring settings saved.'); this.configurationSaved.emit(); },
      error: () => { this.saving.set(false); this.settingsMessage.set('Could not save dashboard monitoring settings. Please try again.'); },
    });
  }
  readonly configurationSaved = output<void>();
}
