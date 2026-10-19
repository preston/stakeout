import { DOCUMENT } from '@angular/common';
import { Component, ElementRef, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { MonitoredService } from '../../core/models/monitored-service.model';
import { ClockService } from '../../core/services/clock.service';
import { TimeAgoPipe } from '../../shared/pipes/time-ago.pipe';

@Component({
  selector: 'app-screenshot-viewer',
  standalone: true,
  imports: [TimeAgoPipe],
  templateUrl: './screenshot-viewer.component.html',
  styleUrl: './screenshot-viewer.component.scss',
  host: { '(document:fullscreenchange)': 'syncFullscreen()' },
})
export class ScreenshotViewerComponent {
  readonly service = input<MonitoredService | null>(null);
  readonly closed = output<void>();
  readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  readonly content = viewChild<ElementRef<HTMLElement>>('content');
  protected readonly clock = inject(ClockService);
  private readonly document = inject(DOCUMENT);
  readonly fullscreen = signal(false);
  readonly fullscreenError = signal(false);
  readonly loading = signal(true);
  readonly imageFailed = signal(false);
  readonly originalUrl = computed(() => this.service()?.screenshot?.original_url ?? null);
  readonly imageAttempt = signal(0);
  private backdropPressed = false;

  constructor() {
    effect(() => {
      const service = this.service();
      const dialog = this.dialog()?.nativeElement;
      if (!dialog) return;
      if (service && !dialog.open) dialog.showModal();
      if (!service && dialog.open) void this.close();
    });
    effect(() => {
      // Only a new image URL starts another load; status-only refreshes keep it.
      this.originalUrl();
      this.loading.set(true);
      this.imageFailed.set(false);
    });
    effect(() => {
      const service = this.service();
      untracked(() => {
        if (service?.screenshot && this.imageFailed()) {
          this.imageFailed.set(false);
          this.loading.set(true);
          this.imageAttempt.update(attempt => attempt + 1);
        }
      });
    });
  }

  private outsideDialog(event: MouseEvent): boolean {
    const dialog = this.dialog()?.nativeElement;
    if (!dialog || event.target !== dialog) return false;
    const rect = dialog.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right ||
      event.clientY < rect.top || event.clientY > rect.bottom;
  }

  onPointerDown(event: PointerEvent): void {
    this.backdropPressed = this.outsideDialog(event);
  }

  onClick(event: MouseEvent): void {
    if (this.backdropPressed && this.outsideDialog(event)) void this.close();
    this.backdropPressed = false;
  }

  onCancel(event: Event): void {
    event.preventDefault();
    void this.close();
  }

  onClosed(): void {
    this.fullscreenError.set(false);
    this.closed.emit();
  }

  async close(): Promise<void> {
    try {
      if (this.document.fullscreenElement === this.content()?.nativeElement) await this.document.exitFullscreen();
    } catch {
      // Closing the dialog must still work if the browser rejects fullscreen exit.
    } finally {
      this.dialog()?.nativeElement.close();
    }
  }

  async toggleFullscreen(): Promise<void> {
    this.fullscreenError.set(false);
    try {
      if (this.document.fullscreenElement === this.content()?.nativeElement) {
        await this.document.exitFullscreen();
      } else {
        const content = this.content()?.nativeElement;
        if (!content?.requestFullscreen) throw new Error('Full screen unavailable');
        await content.requestFullscreen();
        // The user may have closed the dialog while the browser was entering.
        if (!this.dialog()?.nativeElement.open && this.document.fullscreenElement === content) {
          await this.document.exitFullscreen();
        }
      }
      this.syncFullscreen();
    } catch {
      this.fullscreenError.set(true);
    }
  }

  syncFullscreen(): void {
    this.fullscreen.set(Boolean(this.content()?.nativeElement &&
      this.document.fullscreenElement === this.content()?.nativeElement));
  }
}
