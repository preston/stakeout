// Author: Preston Lee

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Dashboard } from '../../core/models/dashboard.model';
import { MonitoredService } from '../../core/models/monitored-service.model';
import { ServiceCardComponent } from './service-card.component';
import { appConfig } from '../../app.config';
import { vi } from 'vitest';

describe('ServiceCardComponent', () => {
  let component: ServiceCardComponent;
  let fixture: ComponentFixture<ServiceCardComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ServiceCardComponent],
      providers: [...appConfig.providers],
    });
    fixture = TestBed.createComponent(ServiceCardComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('dashboard', new Dashboard());
    fixture.componentRef.setInput('service', new MonitoredService());
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should report unknown status when service has not been checked', () => {
    const service = new MonitoredService();
    expect(component.statusLevel(service)).toBe('unknown');
  });

  it('links to the actual monitored protocol, port and normalized path for successful and failed checks', () => {
    for (const host of ['example.com','::1','[::1]']) {
      for (const healthy of [true,false]) {
        const service = Object.assign(new MonitoredService(), { host,port:8123,http:true,https:true,http_path:'health?ready=1',http_path_last:healthy,https_path_last:healthy });
        fixture.componentRef.setInput('service',service); fixture.detectChanges();
        const links = Array.from(fixture.nativeElement.querySelectorAll('.badges a')) as HTMLAnchorElement[];
        const address = host.includes(':')?'[::1]':'example.com';
        expect(links.map(link=>link.getAttribute('href'))).toEqual([`http://${address}:8123/health?ready=1`,`https://${address}:8123/health?ready=1`]);
      }
    }
    fixture.componentRef.setInput('service',Object.assign(new MonitoredService(),{host:'example.com',http:true,http_path:'/health'})); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.badges a').getAttribute('href')).toBe('http://example.com/health');
  });

  it('renders the cached square preview and emits the selected service on click', () => {
    const opened = vi.fn();
    component.screenshotOpened.subscribe(opened);
    const service = Object.assign(new MonitoredService(), { id: 'service-1', name: 'Example',
      screenshot: { preview_url: '/images/preview.webp', original_url: '/images/original.png' } });
    fixture.componentRef.setInput('service', service);
    fixture.detectChanges();
    const image = fixture.nativeElement.querySelector('img') as HTMLImageElement;
    expect(image.getAttribute('src')).toBe('/images/preview.webp');
    expect(image.width).toBe(image.height);
    const button = fixture.nativeElement.querySelector('.screenshot-button') as HTMLButtonElement;
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    button.click();
    expect(opened).toHaveBeenCalledWith('service-1');
    expect(fixture.nativeElement.querySelector('img[src="/images/original.png"]')).toBeNull();
  });

  it('retries a failed preview after a successful dashboard refresh with the same image URL', () => {
    const service = Object.assign(new MonitoredService(), { id: 'service-1', name: 'Example',
      screenshot: { preview_url: '/images/preview.webp', original_url: '/images/original.png' } });
    fixture.componentRef.setInput('service', service);
    fixture.detectChanges();
    fixture.nativeElement.querySelector('img').dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('img')).toBeNull();
    fixture.componentRef.setInput('service', { ...service, checked_at: new Date().toISOString() });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('img')?.getAttribute('src')).toBe('/images/preview.webp');
  });
  it('distinguishes degraded status from full failure and bounds stale data', () => {
    const service = Object.assign(new MonitoredService(), { http: true, https: true, http_path_last: true, https_path_last: false, checked_at: new Date().toISOString() });
    expect(component.availabilityState(service)).toBe('degraded'); expect(component.statusLevel(service)).toBe('degraded');
    service.http_path_last = false; expect(component.availabilityState(service)).toBe('down');
    service.checked_at = new Date(Date.now() - 181000).toISOString(); expect(component.availabilityState(service)).toBe('unknown');
  });

  it('labels paused and unconfigured services without treating them as healthy', () => {
    const service = Object.assign(new MonitoredService(), { http: true, checked_at: new Date().toISOString() });
    fixture.componentRef.setInput('dashboard', Object.assign(new Dashboard(), { monitoring_enabled: false })); fixture.detectChanges();
    expect(component.availabilityState(service)).toBe('paused');
    fixture.componentRef.setInput('dashboard', new Dashboard()); fixture.detectChanges();
    service.http = false; expect(component.availabilityState(service)).toBe('unconfigured');
  });

});
