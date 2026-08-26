import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { SessionsService, HandoffInfo } from './sessions.service';

/** Un mensaje del hilo (fusión del buffer del servidor + eventos socket). */
export interface ChatMessage {
  direction: 'in' | 'out';
  id: string | null;
  body: string;
  timestamp: string;
  senderName?: string | null;
  participant?: string | null;
  hasMedia?: boolean;
  source?: string;
}

export interface Conversation {
  clientId: number;
  contactJid: string;
  senderName: string | null;
  isGroup: boolean;
  lastAt: string;
  lastBody: string;
  messages: ChatMessage[];
  unread: number;
}

interface RecentConversation {
  clientId: number;
  contactJid: string;
  senderName: string | null;
  isGroup: boolean;
  lastAt: string | null;
  messages: any[];
}

const convKey = (clientId: number, contactJid: string) => `${clientId}|${contactJid}`;

/**
 * Store del chat en vivo. Fuentes:
 *  - Seed: GET /api/sessions/chat/recent (ring buffer RAM del backend — contexto
 *    reciente; un reinicio del backend lo vacía: NO hay histórico persistente).
 *  - Vivo: eventos message:incoming/outgoing del socket (SessionsService).
 * Fusión reactiva con dedupe por id de mensaje (o timestamp+body si no hay id).
 */
@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly http = inject(HttpClient);
  private readonly sessionsApi = inject(SessionsService);

  private readonly seed = signal<RecentConversation[]>([]);
  private readonly seededAt = signal<string>('');
  // Última lectura por conversación (para contadores de no leídos).
  private readonly lastRead = signal<Record<string, string>>({});

  /** Conversaciones fusionadas, agrupadas por cliente. */
  readonly byClient = computed<Map<number, Conversation[]>>(() => {
    const convs = new Map<string, Conversation>();

    // 1) Seed del servidor
    for (const rc of this.seed()) {
      convs.set(convKey(rc.clientId, rc.contactJid), {
        clientId: rc.clientId,
        contactJid: rc.contactJid,
        senderName: rc.senderName,
        isGroup: Boolean(rc.isGroup),
        lastAt: rc.lastAt || '',
        lastBody: '',
        messages: (rc.messages || []).map((m: any) => ({
          direction: m.direction === 'out' ? 'out' : 'in',
          id: m.id ?? null,
          body: m.body || '',
          timestamp: m.timestamp,
          senderName: m.senderName ?? null,
          participant: m.participant ?? null,
          hasMedia: Boolean(m.hasMedia),
          source: m.source,
        })),
        unread: 0,
      });
    }

    // 2) Eventos en vivo (events() viene más-reciente-primero → invertir)
    const live = this.sessionsApi.events();
    for (let i = live.length - 1; i >= 0; i--) {
      const ev = live[i];
      if (!ev.clientId || !ev.contactJid) continue;
      const key = convKey(ev.clientId, ev.contactJid);
      let conv = convs.get(key);
      if (!conv) {
        conv = {
          clientId: ev.clientId,
          contactJid: ev.contactJid,
          senderName: null,
          isGroup: Boolean(ev.isGroup),
          lastAt: '',
          lastBody: '',
          messages: [],
          unread: 0,
        };
        convs.set(key, conv);
      }
      const msgId = ev.messageId ?? null;
      const dupe = conv.messages.some((m) =>
        (msgId && m.id === msgId) || (!msgId && m.timestamp === ev.timestamp && m.body === ev.body),
      );
      if (dupe) continue;
      conv.messages.push({
        direction: ev.direction === 'incoming' ? 'in' : 'out',
        id: msgId,
        body: ev.body,
        timestamp: ev.timestamp,
        senderName: ev.senderName ?? null,
        participant: ev.participant ?? null,
        hasMedia: ev.hasMedia,
        source: ev.source,
      });
      if (ev.direction === 'incoming' && ev.senderName) conv.senderName = ev.senderName;
      if (ev.isGroup) conv.isGroup = true;
    }

    // 3) Orden interno, último mensaje y no leídos
    const read = this.lastRead();
    for (const [key, conv] of convs) {
      conv.messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const last = conv.messages[conv.messages.length - 1];
      if (last) {
        conv.lastAt = last.timestamp;
        conv.lastBody = last.body;
      }
      const since = read[key] || '';
      conv.unread = conv.messages.filter((m) => m.direction === 'in' && m.timestamp > since).length;
    }

    // 4) Agrupar por cliente, conversaciones más recientes primero
    const byClient = new Map<number, Conversation[]>();
    for (const conv of convs.values()) {
      const list = byClient.get(conv.clientId) || [];
      list.push(conv);
      byClient.set(conv.clientId, list);
    }
    for (const list of byClient.values()) {
      list.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
    }
    return byClient;
  });

  /** No leídos totales por cliente (para la columna de clientes y el menú). */
  readonly unreadByClient = computed<Map<number, number>>(() => {
    const out = new Map<number, number>();
    for (const [clientId, convs] of this.byClient()) {
      out.set(clientId, convs.reduce((acc, c) => acc + c.unread, 0));
    }
    return out;
  });

  /** Handoffs activos indexados por conversación. */
  readonly handoffByConv = computed<Map<string, HandoffInfo>>(() => {
    const out = new Map<string, HandoffInfo>();
    for (const h of this.sessionsApi.handoffs()) {
      out.set(convKey(h.clientId, h.contactJid), h);
    }
    return out;
  });

  /** Carga el contexto reciente del servidor + los handoffs activos. */
  hydrate() {
    this.http.get<{ conversations: RecentConversation[] }>('/api/sessions/chat/recent').subscribe({
      next: (res) => {
        this.seed.set(res.conversations || []);
        this.seededAt.set(new Date().toISOString());
      },
      error: () => {},
    });
    this.http.get<HandoffInfo[]>('/api/sessions/handoff').subscribe({
      next: (list) => this.sessionsApi.handoffs.set(list || []),
      error: () => {},
    });
  }

  markRead(clientId: number, contactJid: string) {
    const key = convKey(clientId, contactJid);
    this.lastRead.set({ ...this.lastRead(), [key]: new Date().toISOString() });
  }

  isHandoff(clientId: number, contactJid: string): HandoffInfo | undefined {
    return this.handoffByConv().get(convKey(clientId, contactJid));
  }

  resumeHandoff(clientId: number, contactJid: string) {
    return this.http.post<{ ok: boolean }>('/api/sessions/contact/resume', { clientId, contactJid });
  }
}
