import { Routes } from '@angular/router';
import { authGuard } from './auth/auth.guard';

export const routes: Routes = [
  {
    path: 'auth/login',
    loadComponent: () => import('./pages/auth/login.component').then((m) => m.LoginComponent),
    title: 'Connexion · Maritime Atlas',
  },
  {
    path: 'auth/register',
    loadComponent: () => import('./pages/auth/register.component').then((m) => m.RegisterComponent),
    title: 'Inscription · Maritime Atlas',
  },
  {
    path: 'palettes',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/palettes/palettes-page.component').then((m) => m.PalettesPageComponent),
    title: 'Mes palettes · Maritime Atlas',
  },
  {
    path: 'about',
    loadComponent: () => import('./pages/about/about.component').then((m) => m.AboutComponent),
    title: 'À propos · Maritime Atlas',
  },
  {
    path: '',
    loadComponent: () => import('./pages/map/map.component').then((m) => m.MapComponent),
    title: 'Maritime Atlas',
  },
];
