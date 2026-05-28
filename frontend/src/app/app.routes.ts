import { Routes } from '@angular/router';
import { authGuard } from './auth/auth.guard';
import { adminGuard } from './auth/admin.guard';

export const routes: Routes = [
  {
    path: 'auth/login',
    loadComponent: () => import('./pages/auth/login.component').then((m) => m.LoginComponent),
    title: 'Connexion · AetherWX',
  },
  {
    path: 'auth/register',
    loadComponent: () => import('./pages/auth/register.component').then((m) => m.RegisterComponent),
    title: 'Inscription · AetherWX',
  },
  {
    path: 'auth/verify',
    loadComponent: () => import('./pages/auth/verify.component').then((m) => m.VerifyComponent),
    title: 'Vérification · AetherWX',
  },
  {
    path: 'auth/google-success',
    loadComponent: () => import('./pages/auth/google-success.component').then((m) => m.GoogleSuccessComponent),
    title: 'Connexion Google · AetherWX',
  },
  {
    path: 'auth/forgot-password',
    loadComponent: () => import('./pages/auth/forgot-password.component').then((m) => m.ForgotPasswordComponent),
    title: 'Mot de passe oublié · AetherWX',
  },
  {
    path: 'auth/reset-password',
    loadComponent: () => import('./pages/auth/reset-password.component').then((m) => m.ResetPasswordComponent),
    title: 'Réinitialiser le mot de passe · AetherWX',
  },
  {
    path: 'palettes',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/palettes/palettes-page.component').then((m) => m.PalettesPageComponent),
    title: 'Mes palettes · AetherWX',
  },
  {
    path: 'admin/users',
    canActivate: [adminGuard],
    loadComponent: () => import('./pages/admin/admin-users.component').then((m) => m.AdminUsersComponent),
    title: 'Admin · Utilisateurs · AetherWX',
  },
  {
    path: 'admin/orchestrator',
    canActivate: [adminGuard],
    loadComponent: () => import('./pages/admin/admin-orchestrator.component').then((m) => m.AdminOrchestratorComponent),
    title: 'Admin · Data Orchestrator · AetherWX',
  },
  {
    path: 'about',
    loadComponent: () => import('./pages/about/about.component').then((m) => m.AboutComponent),
    title: 'À propos · AetherWX',
  },
  // G11e (2026-05-22) — `/` sert GlobeComponent (MapLibre).
  // G67 (2026-05-28) — suppression de la carte 2D OpenLayers legacy
  // (map.component.ts 8049 lignes) après période de grâce : elle créait
  // de la confusion en dev (2 implémentations à maintenir). OL reste une
  // dépendance pour /palettes (zone-preview + map-projections).
  {
    path: 'globe',
    redirectTo: '',
    pathMatch: 'full',
  },
  {
    path: '',
    loadComponent: () => import('./pages/globe/globe.component').then((m) => m.GlobeComponent),
    title: 'AetherWX',
  },
];
