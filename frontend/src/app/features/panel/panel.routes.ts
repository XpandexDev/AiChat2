import { Routes } from '@angular/router';

export const PANEL_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./client-dashboard.component').then((m) => m.ClientDashboardComponent),
  },
  {
    path: 'ajustes',
    loadComponent: () => import('./client-settings.component').then((m) => m.ClientSettingsComponent),
  },
];
