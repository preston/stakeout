import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { MonitoredService } from '../../core/models/monitored-service.model';
import { ScreenshotViewerComponent } from './screenshot-viewer.component';

describe('ScreenshotViewerComponent', () => {
  let fixture: ComponentFixture<ScreenshotViewerComponent>;
  let component: ScreenshotViewerComponent;
  let dialog: HTMLDialogElement;
  let content: HTMLElement;
  let fullscreenElement: Element | null;

  const service = (version = 'one') => Object.assign(new MonitoredService(), {
    id: 'service-1', name: 'Example', host: 'example.test', http: true, checked_at: new Date().toISOString(),
    screenshot: { preview_url: `/images/${version}.webp`, original_url: `/images/${version}.png` },
  });

  beforeEach(() => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    }) });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: vi.fn(function (this: HTMLDialogElement) {
      if (this.open) {
        this.removeAttribute('open');
        this.dispatchEvent(new Event('close'));
      }
    }) });
    TestBed.configureTestingModule({ imports: [ScreenshotViewerComponent] });
    fixture = TestBed.createComponent(ScreenshotViewerComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    dialog = fixture.nativeElement.querySelector('dialog');
    content = fixture.nativeElement.querySelector('.viewer-content');
    fullscreenElement = null;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: vi.fn(async () => {
      fullscreenElement = null;
      document.dispatchEvent(new Event('fullscreenchange'));
    }) });
    content.requestFullscreen = vi.fn(async () => {
      fullscreenElement = content;
      document.dispatchEvent(new Event('fullscreenchange'));
    });
  });

  afterEach(() => {
    fixture?.destroy();
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, 'fullscreenElement');
    Reflect.deleteProperty(document, 'exitFullscreen');
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  });

  const open = () => {
    fixture.componentRef.setInput('service', service());
    fixture.detectChanges();
  };

  it('opens an accessible dialog and requests only the original image', () => {
    expect(dialog.open).toBe(false);
    expect(fixture.nativeElement.querySelector('img')).toBeNull();
    open();
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute('aria-labelledby')).toBe('screenshot-title');
    expect(fixture.nativeElement.querySelector('img').getAttribute('src')).toBe('/images/one.png');
  });

  it('keeps the dialog open and shows new image and status data after refresh', () => {
    open();
    const image = fixture.nativeElement.querySelector('img') as HTMLImageElement;
    image.dispatchEvent(new Event('load'));
    fixture.detectChanges();
    expect(component.loading()).toBe(false);
    fixture.componentRef.setInput('service', { ...service(), name: 'Renamed', http_path_last: false });
    fixture.detectChanges();
    expect(component.loading()).toBe(false);
    expect(dialog.textContent).toContain('Renamed');
    expect(dialog.querySelector('.text-bg-danger')).not.toBeNull();
    fixture.componentRef.setInput('service', service('two'));
    fixture.detectChanges();
    expect(dialog.open).toBe(true);
    expect(component.loading()).toBe(true);
    expect(image.getAttribute('src')).toBe('/images/two.png');
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(1);
  });

  it('closes with the Close button and Escape', () => {
    const closed = vi.fn();
    component.closed.subscribe(closed);
    open();
    (dialog.querySelector('[autofocus]') as HTMLButtonElement).click();
    expect(dialog.open).toBe(false);
    expect(closed).toHaveBeenCalledTimes(1);
    fixture.componentRef.setInput('service', service('two'));
    fixture.detectChanges();
    const cancel = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(dialog.open).toBe(false);
  });

  it('closes on backdrop clicks while keeping content clicks and drags inside open', () => {
    open();
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({ left: 100, right: 500, top: 100, bottom: 500 } as DOMRect);
    const click = (target: Element, type: string, x: number, y: number) =>
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
    click(content, 'pointerdown', 200, 200);
    click(content, 'click', 200, 200);
    expect(dialog.open).toBe(true);
    click(content, 'pointerdown', 200, 200);
    click(dialog, 'click', 10, 10);
    expect(dialog.open).toBe(true);
    click(dialog, 'pointerdown', 10, 10);
    click(dialog, 'click', 10, 10);
    expect(dialog.open).toBe(false);
  });

  it('updates in native full screen, tracks browser exit, and exits before closing', async () => {
    open();
    await component.toggleFullscreen();
    expect(content.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(component.fullscreen()).toBe(true);
    fixture.componentRef.setInput('service', service('two'));
    fixture.detectChanges();
    expect(dialog.querySelector('img')!.getAttribute('src')).toBe('/images/two.png');
    fullscreenElement = null;
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(component.fullscreen()).toBe(false);
    expect(dialog.open).toBe(true);
    await component.toggleFullscreen();
    await component.close();
    expect(document.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(dialog.open).toBe(false);
  });

  it('keeps Close usable when full screen is denied and recovers on the next image', async () => {
    open();
    content.requestFullscreen = vi.fn().mockRejectedValue(new Error('Denied'));
    await component.toggleFullscreen();
    fixture.detectChanges();
    expect(component.fullscreenError()).toBe(true);
    dialog.querySelector('img')!.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(dialog.textContent).toContain('Screenshot unavailable');
    fixture.componentRef.setInput('service', service('two'));
    fixture.detectChanges();
    expect(component.imageFailed()).toBe(false);
    await component.close();
    expect(dialog.open).toBe(false);
  });

  it('shows missing screenshots and closes when the selected service disappears', () => {
    open();
    fixture.componentRef.setInput('service', { ...service(), screenshot: null });
    fixture.detectChanges();
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain('No screenshot available');
    fixture.componentRef.setInput('service', null);
    fixture.detectChanges();
    expect(dialog.open).toBe(false);
  });

  it('retries a failed original on refresh even when its content hash has not changed', () => {
    open();
    const failedImage = dialog.querySelector('img')!;
    failedImage.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(component.imageFailed()).toBe(true);
    fixture.componentRef.setInput('service', service());
    fixture.detectChanges();
    expect(component.imageFailed()).toBe(false);
    expect(dialog.querySelector('img')).not.toBe(failedImage);
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('/images/one.png');
    dialog.querySelector('img')!.dispatchEvent(new Event('load'));
    fixture.detectChanges();
    const recoveredImage = dialog.querySelector('img');
    fixture.componentRef.setInput('service', service());
    fixture.detectChanges();
    expect(dialog.querySelector('img')).toBe(recoveredImage);
    expect(component.loading()).toBe(false);
  });
});
