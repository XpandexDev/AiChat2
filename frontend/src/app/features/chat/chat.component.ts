import { Component, OnInit, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ChatService, Conversation } from '../../core/api/chat.service';
import { SessionsService } from '../../core/api/sessions.service';
import { ClientsService, Client } from '../../core/api/clients.service';
import { ContactsService } from '../../core/api/contacts.service';
import { ThreadComponent } from './thread.component';
import { AvatarComponent } from '../../shared/avatar.component';

/**
 * Conversaciones en vivo: clientes → contactos → hilo.
 * Sin histórico persistente (decisión de producto): seed = ring buffer RAM del
 * backend + eventos socket. El socket ya está abierto por el layout admin.
 */
@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [DatePipe, ThreadComponent, AvatarComponent],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.scss',
})
export class ChatComponent implements OnInit {
  readonly chat = inject(ChatService);
  readonly contacts = inject(ContactsService);
  private readonly sessionsApi = inject(SessionsService);
  private readonly clientsApi = inject(ClientsService);

  // Perfiles (foto/info/empresa) de las conversaciones del cliente visible.
  // El servicio dedupea y cachea; los grupos solo obtienen foto (backend).
  private readonly profileLoader = effect(() => {
    for (const conv of this.clientConvs()) {
      this.contacts.load(conv.clientId, conv.contactJid);
    }
  });

  readonly clients = signal<Client[]>([]);
  readonly selectedClientId = signal<number | null>(null);
  readonly selectedContact = signal<string | null>(null);
  readonly sending = signal(false);
  readonly error = signal<string | null>(null);

  /** Clientes ordenados: con actividad primero. */
  readonly clientRows = computed(() => {
    const unread = this.chat.unreadByClient();
    const byClient = this.chat.byClient();
    const handoffs = this.sessionsApi.handoffs();
    const sessions = this.sessionsApi.sessions();
    return this.clients()
      .map((c) => {
        const convs = byClient.get(c.id) || [];
        const live = sessions.find((s) => s.clientId === c.id);
        return {
          client: c,
          unread: unread.get(c.id) || 0,
          lastAt: convs[0]?.lastAt || '',
          handoffCount: handoffs.filter((h) => h.clientId === c.id).length,
          sessionStatus: live?.status || null,
        };
      })
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  });

  readonly clientConvs = computed<Conversation[]>(() => {
    const id = this.selectedClientId();
    if (id === null) return [];
    return this.chat.byClient().get(id) || [];
  });

  readonly selectedConv = computed<Conversation | null>(() => {
    const contact = this.selectedContact();
    if (!contact) return null;
    return this.clientConvs().find((c) => c.contactJid === contact) || null;
  });

  readonly selectedHandoff = computed(() => {
    const id = this.selectedClientId();
    const contact = this.selectedContact();
    if (id === null || !contact) return undefined;
    return this.chat.isHandoff(id, contact);
  });

  readonly selectedProfile = computed(() => {
    const id = this.selectedClientId();
    const contact = this.selectedContact();
    if (id === null || !contact) return undefined;
    return this.contacts.get(id, contact);
  });

  /** Sesión lista del cliente seleccionado (para poder responder). */
  readonly readySession = computed(() => {
    const id = this.selectedClientId();
    if (id === null) return null;
    return this.sessionsApi.sessions().find((s) => s.clientId === id && s.status === 'ready') || null;
  });

  ngOnInit() {
    this.chat.hydrate();
    this.clientsApi.list().subscribe({
      next: (list) => {
        this.clients.set(list);
        // Autoselección: primer cliente con actividad
        if (this.selectedClientId() === null) {
          const first = this.clientRows()[0];
          if (first) this.selectClient(first.client.id);
        }
      },
      error: () => this.error.set('No se pudieron cargar los clientes'),
    });
  }

  selectClient(id: number) {
    this.selectedClientId.set(id);
    const first = (this.chat.byClient().get(id) || [])[0];
    this.selectContact(first ? first.contactJid : null);
  }

  selectContact(contactJid: string | null) {
    this.selectedContact.set(contactJid);
    const id = this.selectedClientId();
    if (id !== null && contactJid) this.chat.markRead(id, contactJid);
  }

  send(text: string) {
    const session = this.readySession();
    const contact = this.selectedContact();
    const clientId = this.selectedClientId();
    if (!session || !contact || clientId === null) return;
    this.sending.set(true);
    this.error.set(null);
    this.sessionsApi.sendMessage(session.sessionId, contact, text).subscribe({
      next: () => {
        this.sending.set(false);
        this.chat.markRead(clientId, contact);
      },
      error: (err) => {
        this.sending.set(false);
        this.error.set(err?.error?.error || 'No se pudo enviar el mensaje');
      },
    });
  }

  sendFileAttachment(file: { dataBase64: string; mimetype: string; fileName: string }) {
    const session = this.readySession();
    const contact = this.selectedContact();
    const clientId = this.selectedClientId();
    if (!session || !contact || clientId === null) return;
    this.sending.set(true);
    this.error.set(null);
    this.sessionsApi.sendMedia(session.sessionId, contact, file).subscribe({
      next: () => { this.sending.set(false); this.chat.markRead(clientId, contact); },
      error: (err) => {
        this.sending.set(false);
        this.error.set(err?.error?.error || 'No se pudo enviar el archivo');
      },
    });
  }

  resume() {
    const clientId = this.selectedClientId();
    const contact = this.selectedContact();
    if (clientId === null || !contact) return;
    this.chat.resumeHandoff(clientId, contact).subscribe({ error: () => {} });
  }

  contactLabel(conv: Conversation): string {
    return conv.senderName || this.contactPhone(conv.contactJid);
  }

  contactPhone(jid: string): string {
    const [num, host] = String(jid || '').split('@');
    if (host === 'lid') return num; // LID interno de WhatsApp, no es un teléfono
    return /^\d{6,}$/.test(num) ? `+${num}` : num;
  }

  clientName(id: number | null): string {
    if (id === null) return '';
    return this.clients().find((c) => c.id === id)?.name || `Cliente #${id}`;
  }

  statusDot(status: string | null): string {
    if (status === 'ready') return 'ok';
    if (!status || status === 'stopped') return 'mute';
    return 'warn';
  }
}
