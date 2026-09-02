import { Component, Input, OnDestroy, OnInit, computed, inject, signal, effect } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { Client, ClientsService, BlacklistEntry, ApiKeyInfo, WhitelistState } from '../../core/api/clients.service';
import { SessionsService, WaSession } from '../../core/api/sessions.service';
import { WebhooksService } from '../../core/api/webhooks.service';
import { ChatService, Conversation } from '../../core/api/chat.service';
import { ContactsService } from '../../core/api/contacts.service';
import { ThreadComponent } from '../chat/thread.component';
import { AvatarComponent } from '../../shared/avatar.component';
import { HistoryBadgeComponent } from '../../shared/history-badge.component';
import { errorToMessage } from '../../core/api/error';

type DetailTab = 'resumen' | 'chat' | 'whatsapp' | 'acceso' | 'integracion';

@Component({
  selector: 'app-client-detail',
  standalone: true,
  imports: [RouterLink, FormsModule, DatePipe, ThreadComponent, AvatarComponent, HistoryBadgeComponent],
  templateUrl: './client-detail.component.html',
  styleUrl: './clients.scss',
})
export class ClientDetailComponent implements OnInit, OnDestroy {
  @Input() id?: string;

  private readonly clientsApi = inject(ClientsService);
  private readonly sessionsApi = inject(SessionsService);
  private readonly webhooks = inject(WebhooksService);
  readonly chat = inject(ChatService);
  readonly contacts = inject(ContactsService);
  private readonly router = inject(Router);

  // Perfiles (foto/info/empresa) de conversaciones y handoffs de este cliente.
  private readonly profileLoader = effect(() => {
    const cid = Number(this.id);
    if (!cid) return;
    for (const conv of this.clientConvs()) this.contacts.load(cid, conv.contactJid);
    for (const h of this.clientHandoffs()) this.contacts.load(cid, h.contactJid);
  });

  // --- Pestañas ---
  readonly tab = signal<DetailTab>('resumen');
  readonly tabs: { key: DetailTab; label: string }[] = [
    { key: 'resumen', label: 'Resumen' },
    { key: 'chat', label: 'Conversaciones' },
    { key: 'whatsapp', label: 'WhatsApp' },
    { key: 'acceso', label: 'Acceso' },
    { key: 'integracion', label: 'Integración' },
  ];

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

  // --- Whitelist (lista blanca activable) ---
  readonly whitelist = signal<WhitelistState>({ enabled: false, entries: [] });
  newWlNumber = '';
  newWlNote = '';
  readonly savingWl = signal(false);

  loadWhitelist() {
    this.clientsApi.getWhitelist(Number(this.id)).subscribe({
      next: (st) => this.whitelist.set(st),
      error: () => this.whitelist.set({ enabled: false, entries: [] }),
    });
  }

  toggleWhitelist() {
    const next = !this.whitelist().enabled;
    if (next && !this.whitelist().entries.length
        && !confirm('La lista está vacía: al activarla el bot dejará de responder a TODOS. ¿Continuar?')) return;
    this.savingWl.set(true);
    this.clientsApi.setWhitelistEnabled(Number(this.id), next).subscribe({
      next: (st) => {
        this.whitelist.set(st);
        this.savingWl.set(false);
        this.notice.set(next ? 'Lista blanca activada: el bot solo responde a esos números' : 'Lista blanca desactivada');
      },
      error: (err) => { this.savingWl.set(false); this.error.set(errorToMessage(err, 'No se pudo cambiar la lista blanca')); },
    });
  }

  addWhitelist() {
    const num = this.newWlNumber.trim();
    if (!num) return;
    this.savingWl.set(true);
    this.error.set(null);
    this.clientsApi.addWhitelist(Number(this.id), num, this.newWlNote.trim() || null).subscribe({
      next: (st) => {
        this.whitelist.set(st);
        this.newWlNumber = '';
        this.newWlNote = '';
        this.savingWl.set(false);
        this.notice.set('Número añadido a la lista blanca');
      },
      error: (err) => { this.savingWl.set(false); this.error.set(errorToMessage(err, 'No se pudo añadir el número')); },
    });
  }

  removeWhitelist(jid: string) {
    this.clientsApi.removeWhitelist(Number(this.id), jid).subscribe({
      next: (st) => { this.whitelist.set(st); this.notice.set('Número quitado de la lista blanca'); },
      error: (err) => this.error.set(errorToMessage(err, 'No se pudo quitar el número')),
    });
  }

  // --- API keys (varias por cliente) + webhook de eventos ---
  readonly apiKeys = signal<ApiKeyInfo[]>([]);
  readonly newApiKey = signal<string | null>(null); // solo visible tras crear
  readonly apiKeyBusy = signal(false);
  newKeyName = '';
  eventsUrl = '';
  readonly eventsSecret = signal<string | null>(null);
  readonly savingEvents = signal(false);

  loadApiKeys() {
    this.clientsApi.listApiKeys(Number(this.id)).subscribe({
      next: (list) => this.apiKeys.set(list),
      error: () => this.apiKeys.set([]),
    });
  }

  createApiKey() {
    const name = this.newKeyName.trim() || 'key';
    this.apiKeyBusy.set(true);
    this.error.set(null);
    this.clientsApi.createApiKey(Number(this.id), name).subscribe({
      next: (r) => {
        this.apiKeyBusy.set(false);
        this.newApiKey.set(r.apiKey);
        this.newKeyName = '';
        this.loadApiKeys();
      },
      error: (err) => { this.apiKeyBusy.set(false); this.error.set(errorToMessage(err, 'No se pudo crear la key')); },
    });
  }

  async copyApiKey() {
    const key = this.newApiKey();
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      this.notice.set('API key copiada al portapapeles');
    } catch {
      this.error.set('No se pudo copiar — selecciona y copia manualmente.');
    }
  }

  deleteApiKey(k: ApiKeyInfo) {
    if (!confirm(`¿Eliminar la key "${k.name}" (${k.prefix}…)? Las integraciones que la usen dejarán de funcionar.`)) return;
    this.clientsApi.deleteApiKey(Number(this.id), k.id).subscribe({
      next: () => { this.loadApiKeys(); this.notice.set('Key eliminada'); },
      error: (err) => this.error.set(errorToMessage(err, 'No se pudo eliminar')),
    });
  }

  saveEventsWebhook(regenerate = false) {
    this.savingEvents.set(true);
    this.error.set(null);
    this.clientsApi.setEventsWebhook(Number(this.id), this.eventsUrl.trim(), regenerate).subscribe({
      next: (cfg) => {
        this.savingEvents.set(false);
        this.eventsUrl = cfg.url || '';
        this.eventsSecret.set(cfg.secret);
        this.notice.set(cfg.url ? 'Webhook de eventos guardado' : 'Webhook de eventos desactivado');
      },
      error: (err) => { this.savingEvents.set(false); this.error.set(errorToMessage(err, 'No se pudo guardar')); },
    });
  }

  // --- Grupos (crear / unirse por invitación) ---
  newGroupSubject = '';
  newGroupParticipants = '';
  groupInvite = '';
  readonly groupBusy = signal(false);

  createGroup() {
    const session = this.readySession();
    const subject = this.newGroupSubject.trim();
    const participants = this.newGroupParticipants.split(',').map((p) => p.trim()).filter(Boolean);
    if (!session) { this.error.set('Necesita una sesión de WhatsApp conectada'); return; }
    if (!subject || !participants.length) {
      this.error.set('Nombre del grupo y al menos un teléfono son requeridos');
      return;
    }
    this.groupBusy.set(true);
    this.error.set(null);
    this.sessionsApi.createGroup(session.sessionId, subject, participants).subscribe({
      next: (r) => {
        this.groupBusy.set(false);
        this.newGroupSubject = '';
        this.newGroupParticipants = '';
        this.notice.set(`Grupo "${r.subject}" creado (${participants.length} participantes)`);
      },
      error: (err) => { this.groupBusy.set(false); this.error.set(errorToMessage(err, 'No se pudo crear el grupo')); },
    });
  }

  joinGroup() {
    const session = this.readySession();
    const invite = this.groupInvite.trim();
    if (!session) { this.error.set('Necesita una sesión de WhatsApp conectada'); return; }
    if (!invite) { this.error.set('Pega el enlace de invitación del grupo'); return; }
    this.groupBusy.set(true);
    this.error.set(null);
    this.sessionsApi.joinGroup(session.sessionId, invite).subscribe({
      next: () => {
        this.groupBusy.set(false);
        this.groupInvite = '';
        this.notice.set('El bot se ha unido al grupo');
      },
      error: (err) => { this.groupBusy.set(false); this.error.set(errorToMessage(err, 'No se pudo unir al grupo')); },
    });
  }

  // --- Conversaciones del cliente (pestaña chat, reusa el store global) ---
  readonly selectedContact = signal<string | null>(null);
  readonly sending = signal(false);

  readonly clientConvs = computed<Conversation[]>(() => {
    return this.chat.byClient().get(Number(this.id)) || [];
  });

  readonly selectedConv = computed<Conversation | null>(() => {
    const contact = this.selectedContact();
    if (!contact) return null;
    return this.clientConvs().find((c) => c.contactJid === contact) || null;
  });

  readonly selectedHandoff = computed(() => {
    const contact = this.selectedContact();
    if (!contact) return undefined;
    return this.chat.isHandoff(Number(this.id), contact);
  });

  readonly selectedProfile = computed(() => {
    const contact = this.selectedContact();
    if (!contact) return undefined;
    return this.contacts.get(Number(this.id), contact);
  });

  /** Nombre a mostrar para un contacto en handoff (conversación o teléfono). */
  handoffName(contactJid: string): string {
    const conv = this.clientConvs().find((c) => c.contactJid === contactJid);
    return conv?.senderName || this.contactPhone(contactJid);
  }

  readonly clientHandoffs = computed(() =>
    this.sessionsApi.handoffs().filter((h) => h.clientId === Number(this.id)),
  );

  readonly readySession = computed(() =>
    this.clientSessions().find((s) => s.status === 'ready') || null,
  );

  selectContact(contactJid: string) {
    this.selectedContact.set(contactJid);
    this.chat.markRead(Number(this.id), contactJid);
  }

  sendChat(text: string) {
    const session = this.readySession();
    const contact = this.selectedContact();
    if (!session || !contact) return;
    this.sending.set(true);
    this.sessionsApi.sendMessage(session.sessionId, contact, text).subscribe({
      next: () => this.sending.set(false),
      error: (err) => {
        this.sending.set(false);
        this.error.set(errorToMessage(err, 'No se pudo enviar el mensaje'));
      },
    });
  }

  sendChatFile(file: { dataBase64: string; mimetype: string; fileName: string }) {
    const session = this.readySession();
    const contact = this.selectedContact();
    if (!session || !contact) return;
    this.sending.set(true);
    this.sessionsApi.sendMedia(session.sessionId, contact, file).subscribe({
      next: () => this.sending.set(false),
      error: (err) => {
        this.sending.set(false);
        this.error.set(errorToMessage(err, 'No se pudo enviar el archivo'));
      },
    });
  }

  resumeHandoff(contactJid: string) {
    this.chat.resumeHandoff(Number(this.id), contactJid).subscribe({
      next: () => this.notice.set('Conversación devuelta al bot'),
      error: (err) => this.error.set(errorToMessage(err, 'No se pudo devolver al bot')),
    });
  }

  contactLabel(conv: Conversation): string {
    return conv.senderName || this.contactPhone(conv.contactJid);
  }

  contactPhone(jid: string): string {
    const [num, host] = String(jid || '').split('@');
    if (host === 'lid') return num; // LID interno de WhatsApp, no es un teléfono
    return /^\d{6,}$/.test(num) ? `+${num}` : num;
  }

  ngOnInit() {
    if (!this.id) return;
    this.load();
    this.loadApiKeys();
    this.loadWhitelist();
    this.chat.hydrate();
  }

  ngOnDestroy() {}

  load() {
    if (!this.id) return;
    const id = Number(this.id);
    this.loading.set(true);
    this.clientsApi.get(id).subscribe({
      next: (c) => {
        this.client.set(c);
        this.loading.set(false);
        this.eventsUrl = c.eventsWebhookUrl || '';
        this.eventsSecret.set(c.eventsWebhookSecret);
      },
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

  /** Reanuda una sesión ya existente (detenida/caída) sin crear una nueva. */
  resumeSession(sid: string) {
    const c = this.client();
    if (!c) return;
    this.error.set(null);
    this.sessionsApi.start({ clientId: c.id, sessionId: sid, mode: 'normal' }).subscribe({
      next: () => {
        this.notice.set('Sesión iniciada — si pide QR, escanéalo desde el enlace de activación');
        this.load();
      },
      error: (err) => this.error.set(errorToMessage(err, 'No se pudo iniciar la sesión')),
    });
  }

  /** Estados en los que la sesión NO está corriendo y se puede (re)iniciar. */
  canStart(status: string): boolean {
    return ['stopped', 'auth_failure', 'error', 'disconnected'].includes(status);
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
