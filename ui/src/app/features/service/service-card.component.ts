import {
  Component,
  input,
  output,
  inject,
  signal,
  effect,
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
import { Dashboard } from '../../core/models/dashboard.model';
import { TimeAgoPipe } from '../../shared/pipes/time-ago.pipe';

@Component({
  selector: 'app-service-card',
  templateUrl: './service-card.component.html',
  styleUrl: './service-card.component.scss',
  standalone: true,
  imports: [FormField, TimeAgoPipe],
})
export class ServiceCardComponent {
  dashboard = input.required<Dashboard>();
  service = input.required<MonitoredService>();
  startEditing = input(false);
  serviceUpdated = output<MonitoredService>();
  editingClosed = output<void>();

  private readonly serviceService = inject(ServiceService);
  private readonly toastService = inject(NgToastService);
  private readonly toastErrorService = inject(ToastErrorService);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly settingsService = inject(SettingsService);
  protected readonly clock = inject(ClockService);

  readonly editing = signal(false);
  readonly editDraft = signal<MonitoredService>(new MonitoredService());
  readonly editForm = form(this.editDraft);

  readonly editable = () => this.settingsService.editable();

  constructor() {
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

  statusLevel(s: MonitoredService): string {
    let status = 'unknown';
    if (s.checked_at) {
      if (
        (!s.http || s.http_path_last) &&
        (!s.https || s.https_path_last)
      ) {
        status = 'good';
      } else {
        status = 'bad';
      }
    }
    return status;
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
