import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, OnDestroy, inject, signal } from '@angular/core';
import { Observable } from 'rxjs';
import { Socket, io } from 'socket.io-client';

export interface WaSession {
  sessionId: string;
  clientId: number | null;
  mode: 'normal' | 'business' | null;
  status: string;
  qrDataUrl: string | null;
  lastError: string | null;
  connectedNumber: string | null;
  updatedAt: string;
}

export interface SessionStartInput {
  clientId: number;
  sessionId: string;
  mode?: 'normal' | 'business';
}

export interface RealtimeEvent {
  direction: 'incoming' | 'outgoing';
  sessionId: string;
  clientId?: number;
  from?: string;
  to?: string;
  body: string;
  timestamp: string;
  // Identidad estable del contacto (teléfono; en grupos, el JID del grupo).
  // Es la clave de agrupación del chat: casa IN y OUT aunque WhatsApp use @lid.
  contactJid?: string;
  messageId?: string | null;
  senderName?: string | null;
  isGroup?: boolean;
  participant?: string | null;
  hasMedia?: boolean;
  msgType?: string;
  source?: string;
}

export interface HandoffInfo {
  clientId: number;
  contactJid: string;
  sessionId?: string | null;
  motivo?: string | null;
  resumen?: string | null;
  assignedAt?: string | null;
}

@Injectable({ providedIn: 'root' })
export class SessionsService implements OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly base = '/api/sessions';

  // Tabla de sesiones VIVAS conocida vía socket + REST inicial.
  readonly sessions = signal<WaSession[]>([]);
  readonly events = signal<RealtimeEvent[]>([]);
  // Contactos en modo humano, en vivo (seed por HTTP + eventos handoff:*).
  readonly handoffs = signal<HandoffInfo[]>([]);
  readonly socketConnected = signal(false);
  readonly socketError = signal<string | null>(null);

  private socket: Socket | null = null;
  private refCount = 0;

  /** Conecta el socket si no está conectado. Devuelve función para desconectar. */
  connect(): () => void {
    this.refCount += 1;
    if (this.refCount === 1) this.openSocket();
    return () => this.disconnect();
  }

  private disconnect() {
    this.refCount = Math.max(0, this.refCount - 1);
    if (this.refCount === 0 && this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.socketConnected.set(false);
    }
  }

  private openSocket() {
    // Mismo origin: el proxy de Angular (dev) o el mismo Node (prod) sirven /socket.io
    this.socket = io({ path: '/socket.io', withCredentials: true });

    this.socket.on('connect', () => {
      this.socketConnected.set(true);
      this.socketError.set(null);
    });

    this.socket.on('disconnect', () => {
      this.socketConnected.set(false);
    });

    this.socket.on('connect_error', (err: any) => {
      this.socketError.set(err?.message || 'connect_error');
    });

    this.socket.on('sessions:init', (list: WaSession[]) => {
      this.sessions.set([...list].sort(byId));
    });

    this.socket.on('session:update', (s: WaSession) => {
      const current = this.sessions();
      const idx = current.findIndex((x) => x.sessionId === s.sessionId);
      if (idx >= 0) {
        const next = current.slice();
        next[idx] = s;
        this.sessions.set(next.sort(byId));
      } else {
        this.sessions.set([...current, s].sort(byId));
      }
    });

    this.socket.on('session:removed', (p: { sessionId: string }) => {
      this.sessions.set(this.sessions().filter((s) => s.sessionId !== p.sessionId));
    });

    this.socket.on('message:incoming', (p: any) => {
      this.pushEvent({
        direction: 'incoming',
        sessionId: p.sessionId,
        clientId: p.clientId,
        from: p.message?.from,
        body: p.message?.body || '',
        timestamp: p.timestamp,
        contactJid: p.message?.contactJid,
        messageId: p.message?.id ?? null,
        senderName: p.message?.senderName ?? null,
        isGroup: Boolean(p.message?.isGroup),
        participant: p.message?.participant ?? null,
        hasMedia: Boolean(p.message?.hasMedia),
        msgType: p.message?.type,
        source: p.source,
      });
    });

    this.socket.on('message:outgoing', (p: any) => {
      this.pushEvent({
        direction: 'outgoing',
        sessionId: p.sessionId,
        clientId: p.clientId,
        to: p.message?.to,
        body: p.message?.body || '',
        timestamp: p.timestamp,
        contactJid: p.message?.contactJid || p.message?.to,
        messageId: p.message?.id ?? null,
        source: p.source,
      });
    });

    this.socket.on('handoff:started', (p: any) => {
      const list = this.handoffs().filter(
        (h) => !(h.clientId === p.clientId && h.contactJid === p.contactJid),
      );
      this.handoffs.set([
        { clientId: p.clientId, contactJid: p.contactJid, sessionId: p.sessionId,
          motivo: p.motivo, resumen: p.resumen, assignedAt: p.timestamp },
        ...list,
      ]);
    });

    this.socket.on('handoff:resumed', (p: any) => {
      this.handoffs.set(
        this.handoffs().filter(
          (h) => !(h.clientId === p.clientId && h.contactJid === p.contactJid),
        ),
      );
    });
  }

  private pushEvent(ev: RealtimeEvent) {
    const next = [ev, ...this.events()];
    this.events.set(next.slice(0, 500));
  }

  ngOnDestroy() {
    if (this.socket) this.socket.disconnect();
  }

  // --- REST ---

  list(clientId?: number): Observable<WaSession[]> {
    let params = new HttpParams();
    if (clientId) params = params.set('clientId', String(clientId));
    return this.http.get<WaSession[]>(this.base, { params });
  }

  get(sessionId: string): Observable<WaSession> {
    return this.http.get<WaSession>(`${this.base}/${encodeURIComponent(sessionId)}`);
  }

  start(input: SessionStartInput): Observable<WaSession> {
    return this.http.post<WaSession>(`${this.base}/start`, input);
  }

  stop(sessionId: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.base}/${encodeURIComponent(sessionId)}/stop`, {});
  }

  remove(sessionId: string): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`${this.base}/${encodeURIComponent(sessionId)}`);
  }

  sendMessage(sessionId: string, to: string, text: string): Observable<unknown> {
    return this.http.post('/api/messages/send', { sessionId, to, text });
  }
}

function byId(a: WaSession, b: WaSession): number {
  return a.sessionId.localeCompare(b.sessionId);
}
