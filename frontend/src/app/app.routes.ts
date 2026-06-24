import { Routes } from '@angular/router';
import { authGuard, guestOnlyGuard } from './core/auth/auth.guard';
import { clientAuthGuard, clientGuestOnlyGuard } from './core/auth/client-auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    canActivate: [guestOnlyGuard],
    loadComponent: () => import('./features/login/login.component').then((m) => m.LoginComponent),
  },
  {
    // Pública: el cliente final accede con su pairing token, sin login
    path: 'connect',
    loadChildren: () => import('./features/onboard/onboard.routes').then((m) => m.ONBOARD_ROUTES),
  },
  {
    // Panel self-service del cliente (login propio, separado del admin)
    path: 'panel/login',
    canActivate: [clientGuestOnlyGuard],
    loadComponent: () => import('./features/panel/client-login.component').then((m) => m.ClientLoginComponent),
  },
  {
    path: 'panel',
    canActivate: [clientAuthGuard],
    loadComponent: () => import('./features/panel/client-layout.component').then((m) => m.ClientLayoutComponent),
    children: [
      { path: '', loadChildren: () => import('./features/panel/panel.routes').then((m) => m.PANEL_ROUTES) },
    ],
  },
  { path: 'panel/**', redirectTo: 'panel/login' },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./core/layout/layout.component').then((m) => m.LayoutComponent),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'clients' },
      {
        path: 'clients',
        loadChildren: () => import('./features/clients/clients.routes').then((m) => m.CLIENTS_ROUTES),
      },
      {
        path: 'sessions',
        loadChildren: () => import('./features/sessions/sessions.routes').then((m) => m.SESSIONS_ROUTES),
      },
      {
        path: 'audit',
        loadChildren: () => import('./features/audit/audit.routes').then((m) => m.AUDIT_ROUTES),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
