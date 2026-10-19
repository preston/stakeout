// Author: Preston Lee

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Dashboard } from '../../core/models/dashboard.model';
import { MonitoredService } from '../../core/models/monitored-service.model';
import { ServiceCardComponent } from './service-card.component';
import { appConfig } from '../../app.config';

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
});
