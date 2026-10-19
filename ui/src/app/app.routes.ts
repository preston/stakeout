// Author: Preston Lee

import { Routes } from '@angular/router';
import { DashboardComponent } from './features/dashboard/dashboard.component';
import { HomeComponent } from './features/home/home.component';
import { SettingsComponent } from './features/settings/settings.component';

export const routes: Routes = [
  {
    path: '',
    component: HomeComponent,
    children: [{ path: 'dashboards/:id', component: DashboardComponent }],
  },
  { path: 'settings', component: SettingsComponent },
];
