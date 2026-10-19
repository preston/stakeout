// Author: Preston Lee

import { Routes } from '@angular/router';
import { DashboardComponent } from './features/dashboard/dashboard.component';
import { HomeComponent } from './features/home/home.component';
import { authenticatedGuard } from './core/services/auth.guard';

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./features/auth/login.component').then(m => m.LoginComponent) },
  { path: 'profile', canActivate: [authenticatedGuard], loadComponent: () => import('./features/profile/profile.component').then(m => m.ProfileComponent) },
  { path: 'admin', canActivate: [authenticatedGuard], loadComponent: () => import('./features/admin/admin.component').then(m => m.AdminComponent), children: [
    { path: '', pathMatch: 'full', redirectTo: 'users' },
    { path: 'users', loadComponent: () => import('./features/admin/users.component').then(m => m.UsersComponent) },
  ] },
  { path: '', component: HomeComponent, children: [{ path: 'dashboards/:id', component: DashboardComponent }] },
  { path: '**', redirectTo: '' },
];
