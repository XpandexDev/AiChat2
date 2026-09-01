import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export interface BlacklistEntry {
  contactJid: string;
  note: string | null;
  createdAt: string;
}

export interface HandoffContact {
  contactJid: string;
  replyJid: string | null;
  sessionId: string | null;
  motivo: string | null;
  resumen: string | null;
  assignedAt: string | null;
  expiresAt: string | null;
}

export interface ClientSessionView {
  sessionId: string;
  status: string;
  connectedNumber: string | null;
}

export interface ScheduleWindow {
  weekday: number; // 0=domingo … 6=sábado
  start: string;   // 'HH:mm'
  end: string;     // 'HH:mm'
}

export interface ClientMeClient {
  id: number;
  name: string;
  email: string | null;
  botEnabled: boolean;
  scheduleEnabled: boolean;
  timezone: string;
  autoReplyText: string | null;
  pairingToken: string | null;
  apiKeyPrefix: string | null;
  apiKeyCreatedAt: string | null;
}

export interface ClientMeResponse {
  client: ClientMeClient;
  sessions: ClientSessionView[];
}

export interface SchedulePayload {
  scheduleEnabled: boolean;
  timezone: string;
  autoReplyText: string;
  windows: ScheduleWindow[];
}

@Injectable({ providedIn: 'root' })
export class ClientPanelService {
  private readonly http = inject(HttpClient);
  private readonly base = '/api/client';

  me(): Observable<ClientMeResponse> {
    return this.http.get<ClientMeResponse>(`${this.base}/me`);
  }

  setBot(enabled: boolean): Observable<{ ok: boolean; botEnabled: boolean }> {
    return this.http.patch<{ ok: boolean; botEnabled: boolean }>(`${this.base}/bot`, { enabled });
  }

  getSchedule(): Observable<SchedulePayload> {
    return this.http.get<SchedulePayload>(`${this.base}/schedule`);
  }

  saveSchedule(payload: SchedulePayload): Observable<SchedulePayload> {
    return this.http.put<SchedulePayload>(`${this.base}/schedule`, payload);
  }

  listBlacklist(): Observable<BlacklistEntry[]> {
    return this.http.get<BlacklistEntry[]>(`${this.base}/blacklist`);
  }

  addBlacklist(number: string, note: string | null): Observable<BlacklistEntry[]> {
    return this.http.post<BlacklistEntry[]>(`${this.base}/blacklist`, { number, note });
  }

  removeBlacklist(number: string): Observable<BlacklistEntry[]> {
    return this.http.delete<BlacklistEntry[]>(`${this.base}/blacklist`, {
      params: new HttpParams().set('number', number),
    });
  }

  listHandoff(): Observable<HandoffContact[]> {
    return this.http.get<HandoffContact[]>(`${this.base}/handoff`);
  }

  resumeContact(contactJid: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.base}/contact/resume`, { contactJid });
  }

  sendReply(sessionId: string, to: string, text: string): Observable<unknown> {
    return this.http.post(`${this.base}/send`, { sessionId, to, text });
  }

  // --- Ajustes ---
  generateApiKey(): Observable<{ apiKey: string; apiKeyPrefix: string }> {
    return this.http.post<{ apiKey: string; apiKeyPrefix: string }>(`${this.base}/api-key`, {});
  }

  revokeApiKey(): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`${this.base}/api-key`);
  }

  changePassword(currentPassword: string, newPassword: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.base}/password`, { currentPassword, newPassword });
  }
}
