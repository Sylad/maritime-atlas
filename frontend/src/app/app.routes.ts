import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/map/map.component').then((m) => m.MapComponent),
    title: 'Maritime Atlas',
  },
];
