import {
  Component,
  input,
  output,
  inject,
  signal,
  effect,
  computed,
  untracked,
  DestroyRef,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { form, FormField } from '@angular/forms/signals';
import { NgToastService } from 'ng-angular-popup';
import { MonitoredService } from '../../core/models/monitored-service.model';
import { ServiceService } from '../../core/services/service.service';
import { SettingsService } from '../../core/services/settings.service';
import { ToastErrorService } from '../../core/services/toast-error.service';
import { ClockService } from '../../core/services/clock.service';
import type { HistoryServiceSummary } from '../../core/models/history.model';
import { HistoryTimelineComponent } from '../history/history-timeline.component';
import { DecimalPipe } from '@angular/common';
import { Dashboard } from '../../core/models/dashboard.model';
import { TimeAgoPipe } from '../../shared/pipes/time-ago.pipe';
import { serviceTargetUrl } from '@stakeout/core';

@Component({
  selector: 'app-service-card',
  templateUrl: './service-card.component.html',
  styleUrl: './service-card.component.scss',
  standalone: true,
  imports: [FormField, TimeAgoPipe, HistoryTimelineComponent, DecimalPipe],
})
export class ServiceCardComponent {
  dashboard = input.required<Dashboard>();
  service = input.required<MonitoredService>();
  startEditing = input(false);
  history = input<HistoryServiceSummary>();
  historyOpened = output<string>();
  serviceUpdated = output<MonitoredService>();
  editingClosed = output<void>();
  screenshotOpened = output<string>();

  private readonly serviceService = inject(ServiceService);
  private readonly toastService = inject(NgToastService);
  private readonly toastErrorService = inject(ToastErrorService);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly settingsService = inject(SettingsService);
  protected readonly clock = inject(ClockService);

  readonly editing = signal(false);
  readonly failedPreview = signal<string | null>(null);
  readonly previewUrl = computed(() => {
    const url = this.service().screenshot?.preview_url;
    return this.settingsService.screenshots() && url && url !== this.failedPreview() ? url : null;
  });
  readonly editDraft = signal<MonitoredService>(new MonitoredService());
  readonly editForm = form(this.editDraft);

  readonly editable = () => this.settingsService.editable();

  targetUrl(service: MonitoredService, secure: boolean): string | null {
    try { return new URL(serviceTargetUrl(service, secure)).href; }
    catch { return null; }
  }

  constructor() {
    effect(() => {
      if (!this.settingsService.editable()) untracked(() => this.editing.set(false));
    });
    effect(() => {
      this.service();
      // Retry only on a later dashboard response, never in an image-error loop.
      untracked(() => this.failedPreview.set(null));
    });
    effect(() => {
      if (this.startEditing()) {
        this.openEditing();
      }
    });
  }

  openEditing(): void {
    const s = this.service();
    this.editDraft.set({ ...s });
    this.editing.set(true);
  }

  closeEditing(): void {
    this.editing.set(false);
    this.editingClosed.emit();
  }

  availabilityState(s: MonitoredService): string {
    const historical = this.history();
    if (this.dashboard().monitoring_enabled === false) return 'paused';
    if (!s.http && !s.https) return 'unconfigured';
    if (!s.checked_at || Date.parse(s.checked_at) < this.clock.now() - (this.dashboard().check_interval_seconds ?? 60) * 3000) return 'unknown';
    if (historical) return historical.current_state;
    const results = [s.http ? s.http_path_last === true : null, s.https ? s.https_path_last === true : null].filter(value => value !== null);
    return results.every(Boolean) ? 'up' : results.some(Boolean) ? 'degraded' : 'down';
  }

  statusLevel(s: MonitoredService): string {
    const state = this.availabilityState(s);
    return state === 'up' ? 'good' : state === 'down' ? 'bad' : state === 'degraded' ? 'degraded' : 'unknown';
  }

  update(event?: Event): void {
    event?.preventDefault();
    const d = this.dashboard();
    const s = this.editDraft();
    this.serviceService
      .update(d, s)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (updated) => {
          this.toastService.success('Service updated');
          this.closeEditing();
          this.serviceUpdated.emit(updated);
        },
        error: (e) => {
          if (!this.toastErrorService.checkAccessDenied(e)) {
            this.toastService.danger(
              this.serviceService.formatErrorsTextFromResponse(e),
              'Service not updated.'
            );
          }
        },
      });
  }
}
