import {
  Component,
  inject,
  signal,
  effect,
  untracked,
  DestroyRef,
} from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { form, FormField } from '@angular/forms/signals';
import { catchError, of, tap } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { NgToastService } from 'ng-angular-popup';
import { DashboardService } from '../../core/services/dashboard.service';
import { SettingsService } from '../../core/services/settings.service';
import { ToastErrorService } from '../../core/services/toast-error.service';
import { Dashboard } from '../../core/models/dashboard.model';

@Component({
  selector: 'app-home',
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, RouterOutlet, FormField],
})
export class HomeComponent {
  private readonly dashboardService = inject(DashboardService);
  private readonly router = inject(Router);
  private readonly toastService = inject(NgToastService);
  private readonly toastErrorService = inject(ToastErrorService);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly settingsService = inject(SettingsService);

  readonly title =
    (window as unknown as { STAKEOUT_UI_TITLE?: string })['STAKEOUT_UI_TITLE'] ?? '';
  readonly sidebarActive = signal(true);
  readonly editingId = signal<string | null>(null);
  readonly editDraft = signal<Dashboard>(new Dashboard());
  readonly editForm = form(this.editDraft);
  readonly dashboard = signal<Dashboard | null>(null);
  readonly sort = signal<'name'>('name');
  readonly order = signal<'asc' | 'desc'>('asc');
  readonly dashboardsLoadError = signal(false);

  readonly editable = () => this.settingsService.editable();

  readonly dashboardsResource = rxResource({
    params: () => ({ sort: this.sort(), order: this.order() }),
    stream: ({ params }) =>
      this.dashboardService.index(false, params.sort, params.order).pipe(
        tap(() => this.dashboardsLoadError.set(false)),
        catchError((e) => {
          this.dashboardsLoadError.set(true);
          if (!this.toastErrorService.checkAccessDenied(e)) {
            this.toastService.danger(
              this.dashboardService.formatErrorsTextFromResponse(e),
              'Could not load dashboards.'
            );
          }
          return of([] as Dashboard[]);
        })
      ),
    defaultValue: [] as Dashboard[],
  });

  readonly dashboards = () => this.dashboardsResource.value() ?? [];
  readonly dashboardsLoading = () => this.dashboardsResource.isLoading();

  constructor() {
    effect(() => {
      const dashboards = this.dashboards();
      if (this.router.url === '/' && dashboards.length > 0) {
        untracked(() => this.router.navigate(['/dashboards', dashboards[0].id]));
      }
    });
  }

  isEditing(id: string): boolean {
    return this.editingId() === id;
  }

  startEditing(d: Dashboard): void {
    this.editingId.set(d.id);
    this.editDraft.set({ ...d });
  }

  stopEditing(): void {
    this.editingId.set(null);
  }

  lock(): void {
    this.settingsService.setEditable(false);
  }

  sortBy(sort: 'name'): void {
    this.sort.set(sort);
    this.order.update((o) => (o === 'asc' ? 'desc' : 'asc'));
    this.dashboardsResource.reload();
  }

  select(d: Dashboard | null): void {
    if (d) {
      this.dashboard.set(d);
      this.router.navigate(['/dashboards', d.id]);
    } else {
      this.dashboard.set(null);
      this.router.navigate(['/']);
    }
  }

  toggleSidebar(): void {
    this.sidebarActive.update((v) => !v);
  }

  create(): void {
    const newDashboard = new Dashboard();
    newDashboard.name = 'Dashboard ' + uuidv4().substring(0, 4);
    this.dashboardService
      .create(newDashboard)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.toastService.success(
            'Please update the details accordingly!',
            'Dashboard created.'
          );
          this.dashboardsResource.reload();
          this.select(r);
          this.startEditing(r);
        },
        error: (e) => {
          if (!this.toastErrorService.checkAccessDenied(e)) {
            this.toastService.danger(
              this.dashboardService.formatErrorsTextFromResponse(e),
              'Dashboard not created.'
            );
          }
        },
      });
  }

  update(event?: Event): void {
    event?.preventDefault();
    const payload = this.editDraft();
    this.dashboardService
      .update(payload)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (updated) => {
          this.toastService.success('Dashboard updated');
          this.stopEditing();
          this.dashboardsResource.reload();
          this.select(updated);
        },
        error: (e) => {
          if (!this.toastErrorService.checkAccessDenied(e)) {
            this.toastService.danger(
              this.dashboardService.formatErrorsTextFromResponse(e),
              'Dashboard not updated.'
            );
          }
        },
      });
  }

  delete(d: Dashboard): void {
    this.dashboardService
      .delete(d)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.toastService.success(
            "It's service list has also been removed.",
            'Dashboard deleted'
          );
          this.select(null);
          this.dashboardsResource.reload();
        },
        error: (e) => {
          if (!this.toastErrorService.checkAccessDenied(e)) {
            this.toastService.danger(
              this.dashboardService.formatErrorsTextFromResponse(e),
              'Dashboard not deleted.'
            );
          }
        },
      });
  }
}
