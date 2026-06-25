import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { SessionsService } from '../../core/api/sessions.service';
import { ClientsService, Client } from '../../core/api/clients.service';
import { errorToMessage } from '../../core/api/error';

@Component({
  selector: 'app-sessions-list',
  standalone: true,
  imports: [RouterLink, FormsModule, DatePipe],
  templateUrl: './sessions-list.component.html',
  styleUrl: './sessions.scss',
})
export class SessionsListComponent implements OnInit, OnDestroy {
  private readonly sessionsApi = inject(SessionsService);
  private readonly clientsApi = inject(ClientsService);

  readonly sessions = this.sessionsApi.sessions;
  readonly events = this.sessionsApi.events;

  readonly clients = signal<Client[]>([]);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);

  newSessionClientId: number | null = null;
  newSessionId = '';
  newSessionMode: 'normal' | 'business' = 'normal';

  sendSessionId = '';
  sendTo = '';
  sendText = '';

  ngOnInit() {
    this.clientsApi.list(true).subscribe({
      next: (list) => this.clients.set(list),
      error: () => this.clients.set([]),
    });
    // Trigger a fresh fetch (socket already pushes sessions:init pero forzamos)
    this.sessionsApi.list().subscribe({
      next: (list) => this.sessionsApi.sessions.set(list),
      error: () => {},
    });
  }

  ngOnDestroy() {}

  clientName(id: number | null | undefined): string {
    if (!id) return '—';
    const c = this.clients().find((x) => x.id === id);
    return c?.name || `#${id}`;
  }

  startSession() {
    if (!this.newSessionClientId || !this.newSessionId.trim()) return;
    this.error.set(null);
    this.sessionsApi.start({
      clientId: this.newSessionClientId,
      sessionId: this.newSessionId.trim(),
      mode: this.newSessionMode,
    }).subscribe({
      next: () => { this.notice.set('Sesión iniciada'); this.newSessionId = ''; },
      error: (err) => this.error.set(errorToMessage(err, 'No se pudo iniciar la sesión')),
    });
  }

  stopSession(sid: string) {
    this.sessionsApi.stop(sid).subscribe({
      error: (err) => this.error.set(errorToMessage(err, 'No se pudo parar la sesión')),
    });
  }

  removeSession(sid: string) {
    if (!confirm(`¿Eliminar "${sid}"?`)) return;
    this.sessionsApi.remove(sid).subscribe({
      error: (err) => this.error.set(errorToMessage(err, 'No se pudo eliminar')),
    });
  }

  sendMessage() {
    if (!this.sendSessionId.trim() || !this.sendTo.trim() || !this.sendText.trim()) return;
    this.error.set(null);
    this.sessionsApi.sendMessage(
      this.sendSessionId.trim(),
      this.sendTo.trim(),
      this.sendText.trim(),
    ).subscribe({
      next: () => { this.notice.set('Mensaje enviado'); this.sendText = ''; },
      error: (err) => this.error.set(errorToMessage(err, 'No se pudo enviar')),
    });
  }

  statusVariant(status: string): string {
    switch (status) {
      case 'ready': case 'authenticated': return 'ok';
      case 'waiting_qr_scan': return 'warn';
      case 'starting': return 'info';
      case 'error': case 'auth_failure': return 'err';
      default: return 'mute';
    }
  }

  statusLabel(status: string): string {
    const m: Record<string, string> = {
      starting: 'Iniciando', waiting_qr_scan: 'Esperando QR', authenticated: 'Autenticado',
      ready: 'Conectado', auth_failure: 'Fallo auth', disconnected: 'Desconectado',
      stopped: 'Detenido', error: 'Error',
    };
    return m[status] || status;
  }
}
