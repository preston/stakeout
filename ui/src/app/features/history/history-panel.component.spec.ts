import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ActivatedRoute, Router, convertToParamMap, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { BehaviorSubject, of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { HistoryPanelComponent, durationLabel } from './history-panel.component';
import { HistoryService } from '../../core/services/history.service';
import { DashboardService } from '../../core/services/dashboard.service';
import { SettingsService } from '../../core/services/settings.service';
import { Dashboard } from '../../core/models/dashboard.model';
import { MonitoredService } from '../../core/models/monitored-service.model';
import type { DashboardHistoryResponse, HistoryServiceSummary, HistoryQuery } from '../../core/models/history.model';

const statistics = { uptime_percent: 50, coverage_percent: 75, up_ms: 1000, degraded_ms: 500, down_ms: 500, unknown_ms: 1000, paused_ms: 0, known_ms: 2000, total_ms: 3000, outage_count: 1 };
const protocol = { count: 2, failures: 1, response_count: 2, average_ms: 100, min_ms: 80, max_ms: 120 };
const row: HistoryServiceSummary = { service_id: 's1', name: 'API', host: 'example.com', current_state: 'up', latest_check_at: '2026-10-19T12:00:00Z', statistics,
  timeline: [{ from: '2026-10-19T11:00:00Z', to: '2026-10-19T12:00:00Z', state: 'down', states: ['up', 'down'] }],
  performance: { http: protocol, https: protocol }, history_started_at: '2026-10-19T11:00:00Z', availability_pruned_before: null };
const history: DashboardHistoryResponse = { from: '2026-10-19T00:00:00Z', to: '2026-10-20T00:00:00Z', generated_at: new Date().toISOString(), services: [row], summary: statistics,
  pagination: { page: 1, limit: 100, total: 1000, total_pages: 10 } };

describe('HistoryPanelComponent', () => {
  let component: HistoryPanelComponent;
  let fixture: ComponentFixture<HistoryPanelComponent>;
  let parameters: BehaviorSubject<ReturnType<typeof convertToParamMap>>;
  let api: { history: ReturnType<typeof vi.fn>; events: ReturnType<typeof vi.fn>; service: ReturnType<typeof vi.fn>; exportUrl: ReturnType<typeof vi.fn> };
  let navigate: ReturnType<typeof vi.fn>;
  let update: ReturnType<typeof vi.fn>;
  const editable = signal(false);
  beforeEach(async () => {
    editable.set(false);
    parameters = new BehaviorSubject(convertToParamMap({}));
    api = { history: vi.fn(() => of(history)), events: vi.fn(() => of({ ...history, events: [] })),
      service: vi.fn(() => of({ ...row, from: history.from, to: history.to, generated_at: history.generated_at, intervals: [], outages: [], selected_event:null, outage_pagination:{page:1,limit:100,total:0,total_pages:0}, performance_resolution: 'hour', performance_buckets: [], pagination: { page: 1, limit: 100, total: 0, total_pages: 0 } })), exportUrl: vi.fn(() => '/history/export.csv') };
    navigate = vi.fn(() => Promise.resolve(true));
    update = vi.fn(() => of(new Dashboard()));
    TestBed.configureTestingModule({ imports: [HistoryPanelComponent], providers: [
      { provide: HistoryService, useValue: api }, { provide: DashboardService, useValue: { update } },
      { provide: SettingsService, useValue: { editable } }, { provide: ActivatedRoute, useValue: { queryParamMap: parameters.asObservable() } },
      { provide: Router, useValue: { navigate } },
    ] });
    fixture = TestBed.createComponent(HistoryPanelComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('dashboard', Object.assign(new Dashboard(), { id: 'd1', name: 'Status' }));
    fixture.componentRef.setInput('services', [Object.assign(new MonitoredService(), { id: 's1', name: 'API', http: true, checked_at: new Date().toISOString() })]);
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
  });

  it('keeps Overview as default and shows coverage alongside uptime', () => {
    expect(component.view()).toBe('overview');
    expect(fixture.nativeElement.textContent).toContain('50.00%');
    expect(fixture.nativeElement.textContent).toContain('75.0%');
    expect(fixture.nativeElement.textContent).toContain('Partial coverage');
    expect(api.history).toHaveBeenCalledWith('d1', expect.objectContaining({ limit: 100, page: 1 }));
  });

  it('uses shared service/status filters, paging, and sorting in API and URL', async () => {
    component.setFilter('service', 's1'); component.setFilter('state', 'down');
    component.changeView('services'); component.sortBy('uptime'); component.setPage(2);
    fixture.detectChanges(); await fixture.whenStable();
    expect(api.history).toHaveBeenLastCalledWith('d1', expect.objectContaining({ service_id: 's1', state: 'down', sort: 'uptime', page: 2 }));
    expect(navigate).toHaveBeenLastCalledWith([], expect.objectContaining({ queryParams: expect.objectContaining({ view: 'services', service_id: 's1', state: 'down', page: 2 }) }));
  });

  it('restores deep-linked filters and service details, and preserves fixed historical ranges on refresh', async () => {
    parameters.next(convertToParamMap({ view: 'timeline', range: 'custom', from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z', detail: 's1', state: 'degraded' }));
    fixture.detectChanges(); await fixture.whenStable();
    const before = component.query();
    fixture.componentRef.setInput('refreshToken', Date.now()); fixture.detectChanges(); await fixture.whenStable();
    expect(component.view()).toBe('timeline'); expect(component.detailId()).toBe('s1');
    expect(component.query().from).toBe(before.from); expect(component.query().to).toBe(before.to);
    expect(api.service).toHaveBeenCalledWith('d1', 's1', expect.objectContaining({ from: before.from, to: before.to, state: undefined }));
  });

  it('loads events only in Events and links selected events to service details', async () => {
    expect(api.events).not.toHaveBeenCalled();
    component.changeView('events'); fixture.detectChanges(); await fixture.whenStable();
    expect(api.events).toHaveBeenCalled();
    component.openEvent({ id: 'event1', service_id: 's1', service_name: 'API', at: history.from, state: 'down', previous_state: 'up', kind: 'disruption', reason: 'timeout', configuration_id: 'c1' });
    fixture.detectChanges(); await fixture.whenStable();
    expect(component.detailId()).toBe('s1'); expect(component.eventId()).toBe('event1');
    expect(api.service).toHaveBeenLastCalledWith('d1','s1',expect.objectContaining({event_id:'event1'}));
    expect(navigate).toHaveBeenLastCalledWith([], expect.objectContaining({ queryParams: expect.objectContaining({ event: 'event1', detail: 's1' }) }));
  });

  it('restores an older selected event and its exact diagnostics when it is absent from the event feed page', async () => {
    const event={id:'old-event',service_id:'s1',service_name:'API',at:history.from,state:'down',previous_state:'up',kind:'down',reason:'Old failure',configuration_id:'c1'};
    api.service.mockReturnValue(of({...row,from:history.from,to:history.to,selected_event:event,outages:[],performance_buckets:[],performance_resolution:'hour',pagination:{page:1,limit:100,total:1,total_pages:1},
      intervals:[{id:event.id,from:history.from,to:row.timeline[0].from,state:'down',http_state:'down',http_status:503,http_error:'Original event diagnostic',https_state:null,https_status:null,https_error:null,event_kind:'down',last_observed_at:history.from,configuration:{revision:1,host:'old-target.test',port:8123,http_path:'/ready'}}]}));
    parameters.next(convertToParamMap({view:'events',page:'2',detail:'s1',event:'old-event'}));
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(api.service).toHaveBeenLastCalledWith('d1','s1',expect.objectContaining({event_id:'old-event',page:1}));
    expect(component.activeEvent()?.id).toBe('old-event');
    expect(fixture.nativeElement.textContent).toContain('Selected event:');
    expect(fixture.nativeElement.textContent).toContain('Original event diagnostic');
    expect(fixture.nativeElement.querySelector('.service-detail tr.table-active')).not.toBeNull();
    fixture.nativeElement.querySelector('.service-detail .alert button').click();
    fixture.detectChanges(); await fixture.whenStable();
    expect(component.eventId()).toBeNull();
    expect(api.service).toHaveBeenLastCalledWith('d1','s1',expect.objectContaining({event_id:undefined}));
  });

  it('identifies missing or pruned event details instead of labeling the latest observations as the selected event', async () => {
    component.openEvent({id:'removed-event',service_id:'s1',service_name:'API',at:history.from,state:'down',previous_state:'up',kind:'down',reason:null,configuration_id:'c1'});
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('selected event is not available in this period');
    expect(fixture.nativeElement.textContent).not.toContain('Selected event:');
  });

  it('paginates observations and outages independently without hiding existing outages', async () => {
    api.service.mockImplementation((_id:string,_serviceId:string,query:HistoryQuery)=>of({...row,from:history.from,to:history.to,selected_event:null,intervals:[],performance_buckets:[],performance_resolution:'hour',
      outages:[{from:history.from,to:history.to,ongoing:false,interrupted_by:null}],
      pagination:{page:query.page,limit:100,total:300,total_pages:3},outage_pagination:{page:query.outage_page,limit:100,total:102,total_pages:2}}));
    component.openService('s1'); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    const buttons=()=>Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];
    buttons().find(button=>button.textContent==='Next observations')!.click();
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(api.service).toHaveBeenLastCalledWith('d1','s1',expect.objectContaining({page:2,outage_page:1}));
    expect(fixture.nativeElement.textContent).not.toContain('No observed disruptions');
    buttons().find(button=>button.textContent==='Next outages')!.click();
    fixture.detectChanges(); await fixture.whenStable();
    expect(api.service).toHaveBeenLastCalledWith('d1','s1',expect.objectContaining({page:2,outage_page:2}));
  });

  it('requests exact selected timeline periods and exposes keyboard-accessible details', async () => {
    component.openService('s1', row.timeline[0]); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(api.service).toHaveBeenLastCalledWith('d1', 's1', expect.objectContaining({ from: row.timeline[0].from, to: row.timeline[0].to }));
    const panel = fixture.nativeElement.querySelector('.service-detail') as HTMLElement;
    expect(panel.getAttribute('tabindex')).toBe('-1');
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(component.detailId()).toBeNull();
  });

  it('shows empty retained performance and avoids implying uptime before monitoring', async () => {
    component.openService('s1'); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('No retained response-time observations');
    expect(fixture.nativeElement.textContent).toContain('Monitoring began');
  });

  it('places mixed-resolution chart points by time and leaves retention gaps unconnected', async () => {
    api.service.mockReturnValue(of({ ...row, from: '2026-10-01T00:00:00Z', to: '2026-10-11T00:00:00Z', generated_at: history.generated_at,
      intervals: [], outages: [], performance_resolution: 'mixed', pagination: history.pagination,
      performance_buckets: [
        { from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z', http: protocol, https: protocol },
        { from: '2026-10-10T00:00:00Z', to: '2026-10-10T01:00:00Z', http: protocol, https: protocol },
      ] }));
    component.openService('s1'); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(component.chart().http.length).toBe(2);
    expect(Number(component.chart().httpDots[0].x)).toBeCloseTo(30);
    expect(Number(component.chart().httpDots[1].x)).toBeGreaterThan(540);
    expect(fixture.nativeElement.querySelectorAll('circle').length).toBe(4);
  });

  it('shows history failures with retry and blocks invalid custom date requests', async () => {
    api.history.mockReturnValue(throwError(() => new Error('offline')));
    component.setFilter('range', '7d'); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Could not load availability history');
    const calls = api.history.mock.calls.length;
    component.setFilter('range', 'custom'); component.setFilter('from', '2026-10-19T12:00'); component.setFilter('to', '2026-10-18T12:00');
    fixture.detectChanges(); await fixture.whenStable();
    expect(component.rangeError()).toContain('before'); expect(api.history.mock.calls.length).toBe(calls);
  });

  it('allows authenticated editing and validates finite retention or indefinite retention', async () => {
    expect(fixture.nativeElement.querySelector('.monitoring-settings')).toBeNull();
    editable.set(true); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.monitoring-settings')).not.toBeNull();
    component.updateDraft('daily_retention_days', '0'); component.saveSettings(new Event('submit'));
    expect(update).not.toHaveBeenCalled(); expect(component.settingsMessage()).toContain('positive whole');
    component.updateDraft('daily_retention_days', ''); component.updateDraft('hourly_retention_days', '30'); component.saveSettings(new Event('submit'));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ daily_retention_days: null, hourly_retention_days: 30 }));
  });

  it('identifies stale snapshots and offers an explicit history refresh', async () => {
    expect(component.historyStale()).toBe(false);
    api.history.mockReturnValue(of({ ...history, generated_at: new Date(Date.now() - 181000).toISOString() }));
    component.setFilter('range', '7d'); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(component.historyStale()).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('This history snapshot was last refreshed');
  });

  it('keeps service rows bounded and exposes pagination for a thousand services', async () => {
    component.changeView('timeline'); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Page 1 of 10');
    expect(fixture.nativeElement.querySelectorAll('.timeline-row').length).toBe(1);
    expect(component.query().limit).toBe(100);
  });
});

describe('durationLabel', () => {
  it('formats observed downtime at useful precision', () => {
    expect(durationLabel(30000)).toBe('30s'); expect(durationLabel(90000)).toBe('1m 30s');
    expect(durationLabel(3660000)).toBe('1h 1m'); expect(durationLabel(90000000)).toBe('1d 1h');
  });
});


describe('Historical dashboard routing', () => {
  it('retains sorting, filters, view changes, and fixed date ranges with the real Angular router', async () => {
    const dashboard = Object.assign(new Dashboard(), { id: 'd1' });
    const api = { history: vi.fn(() => of(history)), events: vi.fn(() => of({ ...history, events: [] })),
      service: vi.fn(() => of({ ...row, from: history.from, to: history.to, intervals: [], outages: [], performance_resolution: 'hour', performance_buckets: [], pagination: history.pagination })),
      exportUrl: vi.fn(() => '/export.csv') };
    TestBed.configureTestingModule({ imports: [HistoryPanelComponent], providers: [
      provideRouter([{ path: 'dashboards/:id', component: HistoryPanelComponent, data: { dashboard, services: [] } }], withComponentInputBinding()),
      { provide: HistoryService, useValue: api }, { provide: DashboardService, useValue: { update: vi.fn() } },
      { provide: SettingsService, useValue: { editable: signal(false) } },
    ] });
    const harness = await RouterTestingHarness.create('/dashboards/d1?view=services&range=7d');
    const component = harness.routeDebugElement!.componentInstance as HistoryPanelComponent;
    const router = TestBed.inject(Router);
    component.sortBy('uptime'); await harness.fixture.whenStable();
    expect(component.sort()).toBe('uptime'); expect(router.url).toContain('sort=uptime');
    component.setFilter('state', 'down'); await harness.fixture.whenStable();
    expect(component.sort()).toBe('uptime'); expect(component.stateFilter()).toBe('down');
    component.changeView('events'); await harness.fixture.whenStable();
    expect(component.view()).toBe('events'); expect(router.url).toContain('state=down');
    await harness.navigateByUrl('/dashboards/d1?view=timeline&range=custom&from=2026-09-01T00:00:00Z&to=2026-09-02T00:00:00Z&detail=s1');
    expect(component.view()).toBe('timeline'); expect(component.detailId()).toBe('s1');
    const period = component.query(); component.openService('s1'); await harness.fixture.whenStable();
    expect(component.query().from).toBe(period.from); expect(component.query().to).toBe(period.to);
    expect(router.url).toContain('range=custom');
  });
});
