// Author: Preston Lee

import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

@Component({ selector: 'app-admin', imports: [RouterLink, RouterLinkActive, RouterOutlet], template: `
  <div id="system-administration" class="container-fluid p-4">
    <h1 class="h3 mb-4">System Administration</h1>
    <div class="row g-3">
      <aside class="col-12 col-lg-3"><nav class="list-group" aria-label="Administration sections">
        <a id="admin-section-users" class="list-group-item list-group-item-action" routerLink="/admin/users" routerLinkActive="active">Users</a>
      </nav></aside>
      <section class="col-12 col-lg-9"><router-outlet /></section>
    </div>
  </div>` })
export class AdminComponent {}
