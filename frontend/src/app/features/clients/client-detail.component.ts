import { Component, Input, OnDestroy, OnInit, computed, inject, signal, effect } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { Client, ClientsService, BlacklistEntry } from '../../core/api/clients.service';
import { SessionsService, WaSession } from '../../core/api/sessions.service';
import { WebhooksService } from '../../core/api/webhooks.service';
import { errorToMessage } from '../../core/api/error';

@Component({
  selector: 'app-client-detail',
  standalone: true,
  imports: [RouterLink, FormsModule, DatePipe],
  templateUrl: './client-detail.component.html',
  styleUrl: './clients.scss',
})
export class ClientDetailComponent implements OnInit, OnDestroy {
  @Input() id?: string;

  private readonly clientsApi = inject(ClientsService);
  private readonly sessionsApi = inject(SessionsService);
  private readonly webhooks = inject(WebhooksService);
  private readonly router = inject(Router);

  readonly client = signal<Client | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly testing = signal(false);
  readonly regenerating = signal(false);
  readonly savingPassword = signal(false);

  newPassword = '';

  readonly blacklist = signal<BlacklistEntry[]>([]);
  newBlNumber = '';
  newBlNote = '';
  readonly savingBl = signal(false);

  pairingUrl(token: string | null): string {
    if (!token) return '';
    return `${window.location.origin}/connect/${token}`;
  }

  panelUrl(): string {
    return `${window.location.origin}/panel/login`;
  }

  assignPassword() {
    const c = this.client();
    if (!c) return;
    if (this.newPassword.length < 8) {
      this.error.set('La contraseña debe tener al menos 8 caracteres');
      return;
    }
    this.savingPassword.set(true);
    this.error.set(null);
    this.clientsApi.setPassword(c.id, this.newPassword).subscribe({
      next: (r) => {
        this.savingPassword.set(false);
        this.newPassword = '';
        this.client.set({ ...c, passwordConfigured: r.passwordConfigured });
        this.notice.set('Contraseña del panel asignada');
      },
      error: (err) => {
        this.savingPassword.set(false);
        this.error.set(errorToMessage(err, 'No se pudo asignar la contraseña'));
      },
    });
  }

  async copyPairingUrl() {
    const url = this.pairingUrl(this.client()?.pairingToken ?? null);
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      this.notice.set('Enlace copiado al portapapeles');
    } catch {
      this.error.set('No se pudo copiar — selecciona y copia manualmente.');
    }
  }

  regeneratePairing() {
    const c = this.client();
    if (!c) return;
    if (!confirm('¿Generar un enlace nuevo? El enlace anterior dejará de funcionar.')) return;
    this.regenerating.set(true);
    this.clientsApi.regeneratePairing(c.id).subscribe({
      next: (updated) => {
        this.client.set(updated);
        this.regenerating.set(false);
        this.notice.set('Enlace regenerado. El anterior ya no funciona.');
      },
      error: (err) => {
        this.regenerating.set(false);
        this.error.set(errorToMessage(err, 'No se pudo regenerar el enlace'));
      },
    });
  }

  // Sesiones del cliente: combinamos lo que la BD persiste (initial fetch) con
  // updates en vivo del socket (filter sessions del manager por clientId).
  private readonly persistedSessions = signal<WaSession[]>([]);
  readonly clientSessions = computed<WaSession[]>(() => {
    const cid = Number(this.id);
    const live = this.sessionsApi.sessions().filter((s) => s.clientId === cid);
    const liveIds = new Set(live.map((s) => s.sessionId));
    const persisted = this.persistedSessions().filter((s) => !liveIds.has(s.sessionId));
    return [...live, ...persisted].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  });

  newSessionId = '';
  newSessionMode: 'normal' | 'business' = 'normal';

  ngOnInit() {
    if (!this.id) return;
    this.load();
  }

  ngOnDestroy() {}

  load() {
    if (!this.id) return;
    const id = Number(this.id);
    this.loading.set(true);
    this.clientsApi.get(id).subscribe({
      next: (c) => { this.client.set(c); this.loading.set(false); },
      error: (err) => { this.error.set(errorToMessage(err, 'No se pudo cargar el cliente')); this.loading.set(false); },
    });
    this.clientsApi.sessions(id).subscribe({
      next: (list) => this.persistedSessions.set(list),
      error: () => this.persistedSessions.set([]),
    });
    this.clientsApi.listBlacklist(id).subscribe({
      next: (list) => this.blacklist.set(list),
      error: () => this.blacklist.set([]),
    });
  }

  contactNumber(jid: string): string {
    return (jid || '').split('@')[0];
  }

  addBlacklist() {
    const c = this.client();
    const num = this.newBlNumber.trim();
    if (!c || !num) return;
    this.savingBl.set(true);
    this.error.set(null);
    this.clientsApi.addBlacklist(c.id, num, this.newBlNote.trim() || null).subscribe({
      next: (list) => {
        this.blacklist.set(list);
        this.newBlNumber = '';
        this.newBlNote = '';
        this.savingBl.set(false);
        this.notice.set('Número añadido a la lista sin bot');
      },
      error: (err) => { this.savingBl.set(false); this.error.set(errorToMessage(err, 'No se pudo añadir el número')); },
    });
  }

  removeBlacklist(jid: string) {
    const c = this.client();
    if (!c) return;
    this.clientsApi.removeBlacklist(c.id, jid).subscribe({
      next: (list) => { this.blacklist.set(list); this.notice.set('Número quitado de la lista'); },
      error: (err) => this.error.set(errorToMessage(err, 'No se pudo quitar el número')),
    });
  }

  deleteClient() {
    const c = this.client();
    if (!c) return;
    if (!confirm(`¿Borrar el cliente "${c.name}"? Esto cierra sus sesiones de WhatsApp y limpia sus credenciales.`)) return;
    this.clientsApi.remove(c.id).subscribe({
      next: () => this.router.navigate(['/clients']),
      error: (err) => this.error.set(errorToMessage(err, 'No se pudo borrar')),
    });
  }

  toggleActive() {
    const c = this.client();
    if (!c) return;
    this.clientsApi.update(c.id, { isActive: !c.isActive }).subscribe({
      next: (updated) => { this.client.set(updated); this.notice.set(updated.isActive ? 'Cliente activado' : 'Cliente desactivado'); },
      error: (err) => this.error.set(errorToMessage(err, 'No se pudo actualizar el estado')),
    });
  }

  testWebhook() {
    const c = this.client();
    if (!c) return;
    this.testing.set(true);
    this.error.set(null);
    this.webhooks.test(c.id).subscribe({
      next: (r) => { this.testing.set(false); this.notice.set(`Webhook OK (HTTP ${r.status})`); },
      error: (err) => { this.testing.set(false); this.error.set(errorToMessage(err, 'Fallo el test de webhook')); },
    });
  }

  startSession() {
    const c = this.client();
    if (!c || !this.newSessionId.trim()) return;
    this.error.set(null);
    this.sessionsApi.start({
      clientId: c.id,
      sessionId: this.newSessionId.trim(),
      mode: this.newSessionMode,
    }).subscribe({
      next: () => {
        this.notice.set('Sesión iniciada — escanea el QR cuando aparezca');
        this.newSessionId = '';
        this.load();
      },
      error: (err) => this.error.set(errorToMessage(err, 'No se pudo iniciar la sesión')),
    });
  }

  stopSession(sid: string) {
    this.sessionsApi.stop(sid).subscribe({
      next: () => this.load(),
      error: (err) => this.error.set(errorToMessage(err, 'No se pudo parar la sesión')),
    });
  }

  removeSession(sid: string) {
    if (!confirm(`¿Eliminar la sesión "${sid}"? Se borran las credenciales locales.`)) return;
    this.sessionsApi.remove(sid).subscribe({
      next: () => this.load(),
      error: (err) => this.error.set(errorToMessage(err, 'No se pudo eliminar la sesión')),
    });
  }

  statusVariant(status: string): string {
    switch (status) {
      case 'ready':
      case 'authenticated': return 'ok';
      case 'waiting_qr_scan': return 'warn';
      case 'starting': return 'info';
      case 'error':
      case 'auth_failure': return 'err';
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
