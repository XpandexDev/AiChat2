import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Client, ClientsService } from '../../core/api/clients.service';
import { SessionsService } from '../../core/api/sessions.service';
import { ChatService } from '../../core/api/chat.service';
import { errorToMessage } from '../../core/api/error';

@Component({
  selector: 'app-clients-list',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './clients-list.component.html',
  styleUrl: './clients.scss',
})
export class ClientsListComponent implements OnInit {
  private readonly api = inject(ClientsService);
  // Semáforo operativo: sesiones vivas (socket) + handoffs + no leídos del chat.
  readonly sessionsApi = inject(SessionsService);
  readonly chat = inject(ChatService);

  readonly clients = signal<Client[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly activeOnly = signal(false);

  ngOnInit() {
    this.load();
    this.chat.hydrate(); // seed de handoffs + contexto de chat
  }

  load() {
    this.loading.set(true);
    this.error.set(null);
    this.api.list(this.activeOnly()).subscribe({
      next: (list) => { this.clients.set(list); this.loading.set(false); },
      error: (err) => { this.error.set(errorToMessage(err, 'No se pudieron cargar los clientes')); this.loading.set(false); },
    });
  }

  toggleActiveOnly() {
    this.activeOnly.set(!this.activeOnly());
    this.load();
  }

  sessionOf(clientId: number) {
    const all = this.sessionsApi.sessions().filter((s) => s.clientId === clientId);
    return all.find((s) => s.status === 'ready') || all[0] || null;
  }

  sessionDot(clientId: number): string {
    const s = this.sessionOf(clientId);
    if (!s) return 'mute';
    if (s.status === 'ready') return 'ok';
    if (s.status === 'stopped' || s.status === 'auth_failure' || s.status === 'error') return 'err';
    return 'warn';
  }

  sessionLabel(clientId: number): string {
    const s = this.sessionOf(clientId);
    if (!s) return 'Sin sesión';
    if (s.status === 'ready') return s.connectedNumber ? `+${s.connectedNumber}` : 'Conectado';
    return s.status;
  }

  handoffCount(clientId: number): number {
    return this.sessionsApi.handoffs().filter((h) => h.clientId === clientId).length;
  }

  unread(clientId: number): number {
    return this.chat.unreadByClient().get(clientId) || 0;
  }
}
