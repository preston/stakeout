// Author: Preston Lee

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';
import { DashboardComponent } from './dashboard.component';
import { appConfig } from '../../app.config';

describe('DashboardComponent', () => {
  let component: DashboardComponent;
  let fixture: ComponentFixture<DashboardComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [DashboardComponent],
      providers: [
        ...appConfig.providers,
        {
          provide: ActivatedRoute,
          useValue: {
            paramMap: of(convertToParamMap({ id: 'dashboard-1' })),
          },
        },
      ],
    });
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
});
