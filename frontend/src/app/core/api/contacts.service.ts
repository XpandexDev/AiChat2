import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';

export interface BusinessProfile {
  description: string | null;
  category: string | null;
  email: string | null;
  website: string[];
  address: string | null;
}

export interface ContactProfile {
  jid: string;
  phone: string | null;
  isGroup: boolean;
  pictureUrl: string | null;
  about: string | null;
  aboutSetAt: string | null;
  business: BusinessProfile | null;
  fetchedAt: string;
}

/**
 * Perfiles de contacto (foto, "info", empresa) con caché en memoria.
 * Dos modos: admin (clientId explícito) y panel de cliente (endpoint propio).
 * Campos null cuando la privacidad del contacto los oculta — no es un error.
 */
@Injectable({ providedIn: 'root' })
export class ContactsService {
  private readonly http = inject(HttpClient);

  // key `${scope}|${jid}` -> perfil (null = cargado sin datos; undefined = no pedido)
  private readonly store = signal<Record<string, ContactProfile | null>>({});
  private readonly pending = new Set<string>();

  /** Lectura reactiva. Devuelve undefined si aún no se ha pedido. */
  get(clientId: number, jid: string): ContactProfile | null | undefined {
    return this.store()[`${clientId}|${jid}`];
  }

  getForPanel(jid: string): ContactProfile | null | undefined {
    return this.store()[`me|${jid}`];
  }

  /** Dispara la carga (dedupe + caché). Seguro de llamar repetidamente. */
  load(clientId: number, jid: string) {
    this.fetch(`${clientId}|${jid}`, `/api/sessions/contact/profile?clientId=${clientId}&jid=${encodeURIComponent(jid)}`);
  }

  loadForPanel(jid: string) {
    this.fetch(`me|${jid}`, `/api/client/contact-profile?jid=${encodeURIComponent(jid)}`);
  }

  private fetch(key: string, url: string) {
    if (key in this.store() || this.pending.has(key)) return;
    this.pending.add(key);
    this.http.get<{ profile: ContactProfile | null }>(url).subscribe({
      next: (res) => {
        this.pending.delete(key);
        this.store.set({ ...this.store(), [key]: res.profile });
      },
      error: () => {
        this.pending.delete(key);
        this.store.set({ ...this.store(), [key]: null });
      },
    });
  }
}
