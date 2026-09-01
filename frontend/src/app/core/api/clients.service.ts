import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export interface ApiKeyInfo {
  id: number;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface Client {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  description: string | null;
  isActive: boolean;
  tags: string[];
  webhookIncomingUrl: string | null;
  webhookSecretConfigured: boolean;
  pairingToken: string | null;
  passwordConfigured: boolean;
  apiKeyPrefix: string | null;
  apiKeyCreatedAt: string | null;
  eventsWebhookUrl: string | null;
  eventsWebhookSecret: string | null;
  botEnabled: boolean;
  scheduleEnabled: boolean;
  timezone: string;
  autoReplyText: string | null;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface BlacklistEntry {
  contactJid: string;
  note: string | null;
  createdAt: string;
}

export interface ClientInput {
  name?: string;
  email?: string | null;
  phone?: string | null;
  description?: string | null;
  isActive?: boolean;
  tags?: string[];
  webhookIncomingUrl?: string | null;
  webhookSecret?: string | null;
}

@Injectable({ providedIn: 'root' })
export class ClientsService {
  private readonly http = inject(HttpClient);
  private readonly base = '/api/clients';

  list(activeOnly = false): Observable<Client[]> {
    let params = new HttpParams();
    if (activeOnly) params = params.set('active', '1');
    return this.http.get<Client[]>(this.base, { params });
  }

  get(id: number): Observable<Client> {
    return this.http.get<Client>(`${this.base}/${id}`);
  }

  create(input: ClientInput): Observable<Client> {
    return this.http.post<Client>(this.base, input);
  }

  update(id: number, input: ClientInput): Observable<Client> {
    return this.http.put<Client>(`${this.base}/${id}`, input);
  }

  remove(id: number): Observable<{ ok: boolean; sessionsDropped: number }> {
    return this.http.delete<{ ok: boolean; sessionsDropped: number }>(`${this.base}/${id}`);
  }

  sessions(id: number): Observable<any[]> {
    return this.http.get<any[]>(`${this.base}/${id}/sessions`);
  }

  regeneratePairing(id: number): Observable<Client> {
    return this.http.post<Client>(`${this.base}/${id}/pairing/regenerate`, {});
  }

  listApiKeys(id: number): Observable<ApiKeyInfo[]> {
    return this.http.get<ApiKeyInfo[]>(`${this.base}/${id}/api-keys`);
  }

  createApiKey(id: number, name: string): Observable<{ id: number; apiKey: string; name: string; prefix: string }> {
    return this.http.post<{ id: number; apiKey: string; name: string; prefix: string }>(`${this.base}/${id}/api-keys`, { name });
  }

  deleteApiKey(id: number, keyId: number): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`${this.base}/${id}/api-keys/${keyId}`);
  }

  setEventsWebhook(id: number, url: string, regenerateSecret = false): Observable<{ url: string | null; secret: string | null }> {
    return this.http.put<{ url: string | null; secret: string | null }>(`${this.base}/${id}/events-webhook`, { url, regenerateSecret });
  }

  setPassword(id: number, password: string): Observable<{ ok: boolean; passwordConfigured: boolean }> {
    return this.http.post<{ ok: boolean; passwordConfigured: boolean }>(`${this.base}/${id}/password`, { password });
  }

  listBlacklist(id: number): Observable<BlacklistEntry[]> {
    return this.http.get<BlacklistEntry[]>(`${this.base}/${id}/blacklist`);
  }

  addBlacklist(id: number, number: string, note: string | null): Observable<BlacklistEntry[]> {
    return this.http.post<BlacklistEntry[]>(`${this.base}/${id}/blacklist`, { number, note });
  }

  removeBlacklist(id: number, number: string): Observable<BlacklistEntry[]> {
    return this.http.delete<BlacklistEntry[]>(`${this.base}/${id}/blacklist`, {
      params: new HttpParams().set('number', number),
    });
  }
}
