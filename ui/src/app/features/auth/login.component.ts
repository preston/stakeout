// Author: Preston Lee

import { AfterViewInit, Component, ElementRef, inject, signal, viewChild, DestroyRef } from '@angular/core';
import { form, FormField } from '@angular/forms/signals';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService, localReturnUrl } from '../../core/services/auth.service';

@Component({
  selector: 'app-login', imports: [FormField],
  template: `
    <dialog #dialog id="login-dialog" class="border rounded p-4 shadow" aria-labelledby="login-heading" (cancel)="cancel($event)">
      <form (submit)="submit($event)">
        <h1 id="login-heading" class="h4">Sign in</h1>
        @if (error()) { <p class="alert alert-danger" role="alert">{{ error() }}</p> }
        <label for="login-username" class="form-label">Username</label>
        <input id="login-username" class="form-control mb-3" autocomplete="username" autofocus [formField]="loginForm.username" />
        <label for="login-password" class="form-label">Password</label>
        <input id="login-password" class="form-control mb-3" type="password" autocomplete="current-password" [formField]="loginForm.password" />
        <div class="d-flex gap-2">
          <button id="login-submit" class="btn btn-primary" [disabled]="busy()">{{ busy() ? 'Signing in…' : 'Sign in' }}</button>
          <button id="login-cancel" type="button" class="btn btn-outline-secondary" (click)="cancel()" [disabled]="busy()">Cancel</button>
        </div>
      </form>
    </dialog>`,
  styles: [`dialog { width: min(95vw, 420px); color: var(--bs-body-color); background: var(--bs-body-bg); } dialog::backdrop { background: rgb(0 0 0 / 45%); }`],
})
export class LoginComponent implements AfterViewInit {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  readonly draft = signal({ username: '', password: '' });
  readonly loginForm = form(this.draft);
  readonly busy = signal(false);
  readonly error = signal('');
  private readonly returnUrl = localReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl'));

  ngAfterViewInit(): void { this.dialog().nativeElement.showModal(); }
  async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy() || this.destroyRef.destroyed) return;
    this.busy.set(true); this.error.set('');
    try {
      await this.auth.login(this.draft().username, this.draft().password, this.destroyRef);
      if (this.destroyRef.destroyed) return;
      this.draft.update(d => ({ ...d, password: '' }));
      await this.router.navigateByUrl(this.returnUrl);
    } catch (error: unknown) {
      if (this.destroyRef.destroyed) return;
      this.error.set((error as { status?: number }).status === 429 ? 'Too many attempts. Try again later.' : 'Could not sign in. Check your username, password, and connection.');
    } finally { if (!this.destroyRef.destroyed) this.busy.set(false); }
  }
  cancel(event?: Event): void {
    event?.preventDefault();
    if (!this.busy()) void this.router.navigateByUrl(/^\/(admin|profile)(\/|$)/.test(this.returnUrl) ? '/' : this.returnUrl);
  }
}
