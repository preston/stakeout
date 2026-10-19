// Author: Preston Lee

import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { NgToastComponent } from 'ng-angular-popup';
import { SettingsService } from './core/services/settings.service';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
  standalone: true,
  imports: [RouterOutlet, NgToastComponent],
})
export class AppComponent {
  protected readonly settingsService = inject(SettingsService);
}
