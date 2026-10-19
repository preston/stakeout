import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HomeComponent } from './home.component';
import { vi } from 'vitest';
import { appConfig } from '../../app.config';

describe('HomeComponent', () => {
  let component: HomeComponent;
  let fixture: ComponentFixture<HomeComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [...appConfig.providers],
    });
    fixture = TestBed.createComponent(HomeComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should default sidebar to active and sort by name ascending', () => {
    expect(component.sidebarActive()).toBe(true);
    expect(component.sort()).toBe('name');
    expect(component.order()).toBe('asc');
  });
  it('starts with a collapsed mobile sidebar and closes it after dashboard selection', () => {
    const previous = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
    try {
      const mobile = TestBed.createComponent(HomeComponent).componentInstance;
      expect(mobile.sidebarActive()).toBe(false);
      mobile.toggleSidebar(); expect(mobile.sidebarActive()).toBe(true);
      mobile.closeSidebarOnMobile(); expect(mobile.sidebarActive()).toBe(false);
    } finally {
      Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: previous });
    }
  });

});
