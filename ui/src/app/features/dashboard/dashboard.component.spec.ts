// Author: Preston Lee

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { DashboardComponent } from './dashboard.component';
import { appConfig } from '../../app.config';
import { Dashboard } from '../../core/models/dashboard.model';
import { MonitoredService } from '../../core/models/monitored-service.model';
import { HistoryService } from '../../core/services/history.service';
import { SettingsService } from '../../core/services/settings.service';
import { ScreenshotViewerComponent } from '../service/screenshot-viewer.component';

describe('DashboardComponent', () => {
  let component: DashboardComponent;
  let fixture: ComponentFixture<DashboardComponent>;
  let screenshotDemand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    screenshotDemand = vi.fn(() => of({ expires_at: new Date(Date.now() + 90000).toISOString() }));
    TestBed.configureTestingModule({
      imports: [DashboardComponent],
      providers: [
        ...appConfig.providers,
        { provide: HistoryService, useValue: { screenshotDemand } },
        {
          provide: ActivatedRoute,
          useValue: {
            paramMap: of(convertToParamMap({ id: 'dashboard-1' })),
          },
        },
      ],
    });
    // The native dialog itself is exercised in its own component/browser tests.
    TestBed.overrideComponent(ScreenshotViewerComponent, { set: { template: '' } });
    fixture = TestBed.createComponent(DashboardComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should expose loading state from dashboard data resource', () => {
    expect(typeof component.loading()).toBe('boolean');
  });

  it('should not report loaded until dashboard data resolves', () => {
    expect(component.loaded()).toBe(false);
    expect(component.loadedDashboard()).toBeUndefined();
  });

  it('follows the selected service through refreshes and sorting, and clears deleted selections', () => {
    const dashboard = Object.assign(new Dashboard(), { id: 'dashboard-1' });
    const selected = Object.assign(new MonitoredService(), { id: 'service-1', name: 'Selected',
      screenshot: { preview_url: '/one.webp', original_url: '/one.png' } });
    const other = Object.assign(new MonitoredService(), { id: 'service-2' });
    component.dashboardData.set({ dashboard, services: [selected, other] });
    component.selectedServiceId.set(selected.id);
    expect(component.selectedService()).toBe(selected);
    const updated = { ...selected, name: 'Updated', screenshot: { preview_url: '/two.webp', original_url: '/two.png' } };
    component.dashboardData.set({ dashboard, services: [other, updated] });
    expect(component.selectedService()).toBe(updated);
    component.dashboardData.set({ dashboard, services: [other] });
    expect(component.selectedService()).toBeNull();
  });

  it('continues the existing refresh schedule while a screenshot is selected', () => {
    const reload = vi.spyOn(component.dashboardData, 'reload');
    component.selectedServiceId.set('service-1');
    component.lastReload.set(Date.now() - 60_001);
    component.reloadIfNeeded();
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it('renews shared screenshot demand at most every 30 seconds while previews are displayed', () => {
    const dashboard = Object.assign(new Dashboard(), { id: 'dashboard-1' });
    const service = Object.assign(new MonitoredService(), { id: 'service-1', http: true, http_preview: true });
    component.dashboardData.set({ dashboard, services: [service] });
    const now = Date.now(); const time = vi.spyOn(Date, 'now').mockReturnValue(now);
    component.sendScreenshotDemand(); component.sendScreenshotDemand();
    expect(screenshotDemand).toHaveBeenCalledTimes(1);
    time.mockReturnValue(now + 29999); component.sendScreenshotDemand(); expect(screenshotDemand).toHaveBeenCalledTimes(1);
    time.mockReturnValue(now + 30000); component.sendScreenshotDemand(); expect(screenshotDemand).toHaveBeenCalledTimes(2);
    time.mockRestore();
  });

  it('stops screenshot demand when hidden, previews are hidden, refresh is disabled, or another view is open', () => {
    const dashboard = Object.assign(new Dashboard(), { id: 'dashboard-1' });
    const service = Object.assign(new MonitoredService(), { id: 'service-1', http: true, http_preview: true });
    component.dashboardData.set({ dashboard, services: [service] });
    const settings = TestBed.inject(SettingsService);
    component.historyView.set('timeline'); component.sendScreenshotDemand(); expect(screenshotDemand).not.toHaveBeenCalled();
    component.historyView.set('overview'); settings.setScreenshots(false); component.sendScreenshotDemand(); expect(screenshotDemand).not.toHaveBeenCalled();
    settings.setScreenshots(true); settings.change({ refreshIntervalMs: 0 }); component.sendScreenshotDemand(); expect(screenshotDemand).not.toHaveBeenCalled();
    settings.change({ refreshIntervalMs: 60000 });
    component.dashboardData.set({ dashboard, services: [service] });
    const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange')); component.sendScreenshotDemand(); expect(screenshotDemand).not.toHaveBeenCalled();
    visible.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')); expect(screenshotDemand).toHaveBeenCalledTimes(1);
    visible.mockRestore();
  });

  it('allows independent screenshot viewing while availability monitoring is paused', () => {
    const dashboard = Object.assign(new Dashboard(), { id: 'dashboard-1', monitoring_enabled: false });
    const service = Object.assign(new MonitoredService(), { id: 'service-1', https: true, http_preview: true });
    component.dashboardData.set({ dashboard, services: [service] }); component.sendScreenshotDemand();
    expect(screenshotDemand).toHaveBeenCalledWith('dashboard-1');
  });

  it('does not demand captures for disabled dashboards or filtered-out preview services', () => {
    const dashboard = Object.assign(new Dashboard(), { id: 'dashboard-1', screenshots_enabled: false });
    const service = Object.assign(new MonitoredService(), { id: 'service-1', http: true, http_preview: true });
    component.dashboardData.set({ dashboard, services: [service] }); component.sendScreenshotDemand();
    expect(screenshotDemand).not.toHaveBeenCalled();
    component.dashboardData.set({ dashboard: { ...dashboard, screenshots_enabled: true }, services: [service] });
    component.visibleServiceIds.set([]); component.sendScreenshotDemand(); expect(screenshotDemand).not.toHaveBeenCalled();
  });

});
