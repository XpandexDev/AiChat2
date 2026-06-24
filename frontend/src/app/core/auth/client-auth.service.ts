import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, catchError, map, of, tap } from 'rxjs';

export interface ClientProfile {
  id: number;
  name: string;
  email: string | null;
}

// Auth del panel de cliente. Espejo de AuthService (admin) pero contra
// /api/client/auth/*. Sesiones admin y cliente coexisten (signals independientes
// + cookies distintas en el backend).
@Injectable({ providedIn: 'root' })
export class ClientAuthService {
  private readonly http = inject(HttpClient);
  private readonly base = '/api/client/auth';

  private readonly _client = signal<ClientProfile | null>(null);
  private readonly _checked = signal(false);

  readonly client = this._client.asReadonly();
  readonly isAuthenticated = computed(() => this._client() !== null);
  readonly checked = this._checked.asReadonly();

  hydrate(): Observable<ClientProfile | null> {
    return this.http.get<ClientProfile>(`${this.base}/me`).pipe(
      tap((c) => {
        this._client.set(c);
        this._checked.set(true);
      }),
      catchError(() => {
        this._client.set(null);
        this._checked.set(true);
        return of(null);
      }),
    );
  }

  login(email: string, password: string): Observable<ClientProfile> {
    return this.http.post<{ ok: boolean; client: ClientProfile }>(
      `${this.base}/login`,
      { email, password },
    ).pipe(
      map((res) => res.client),
      tap((c) => this._client.set(c)),
    );
  }

  logout(): Observable<unknown> {
    return this.http.post(`${this.base}/logout`, {}).pipe(
      tap(() => this._client.set(null)),
      catchError(() => {
        this._client.set(null);
        return of(null);
      }),
    );
  }
}
