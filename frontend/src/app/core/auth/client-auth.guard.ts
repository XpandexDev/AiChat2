import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { map, of, switchMap } from 'rxjs';
import { ClientAuthService } from './client-auth.service';

export const clientAuthGuard: CanActivateFn = (_route, state) => {
  const auth = inject(ClientAuthService);
  const router = inject(Router);

  const redirectToLogin = () => router.parseUrl(`/panel/login?returnUrl=${encodeURIComponent(state.url)}`);

  if (auth.checked()) {
    return auth.isAuthenticated() ? true : redirectToLogin();
  }
  return auth.hydrate().pipe(
    switchMap((client) => of(client ? true : redirectToLogin())),
    map((r) => r),
  );
};

export const clientGuestOnlyGuard: CanActivateFn = () => {
  const auth = inject(ClientAuthService);
  const router = inject(Router);

  if (auth.checked()) {
    return auth.isAuthenticated() ? router.parseUrl('/panel') : true;
  }
  return auth.hydrate().pipe(
    switchMap((client) => of(client ? router.parseUrl('/panel') : true)),
  );
};
