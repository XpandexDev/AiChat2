import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { AuditFilters, AuditLogEntry, AuditService } from '../../core/api/audit.service';
import { errorToMessage } from '../../core/api/error';

// Los 16 action types que registra el backend hoy (middleware/audit.js callers).
const ACTIONS = [
  'admin_login', 'admin_login_failed', 'admin_logout',
  'client.create', 'client.update', 'client.delete',
  'client.pairing_regenerate', 'client.set_password',
  'client.blacklist_add', 'client.blacklist_remove',
  'session.start', 'session.stop', 'session.delete',
  'group.create', 'group.join',
  'handoff.resume', 'message.send', 'webhook.test',
  'panel.login', 'panel.logout', 'panel.bot_toggle', 'panel.schedule_update',
  'panel.blacklist_add', 'panel.blacklist_remove', 'panel.handoff_resume', 'panel.reply_send',
  'client.api_key_generate', 'client.api_key_revoke',
  'panel.api_key_generate', 'panel.api_key_revoke', 'panel.password_change',
  'api.message_send', 'api.handoff_start', 'api.handoff_resume', 'api.group_create', 'api.group_join',
  'panel.events_webhook_update', 'client.events_webhook_update', 'api.events_webhook_update',
  'client.whitelist_toggle', 'client.whitelist_add', 'client.whitelist_remove',
  'panel.whitelist_toggle', 'panel.whitelist_add', 'panel.whitelist_remove', 'api.whitelist_toggle', 'api.whitelist_add',
] as const;

interface DayGroup {
  day: string; // etiqueta legible
  entries: AuditLogEntry[];
}

@Component({
  selector: 'app-audit-log',
  standalone: true,
  imports: [FormsModule, DatePipe],
  templateUrl: './audit-log.component.html',
  styleUrl: './audit-log.component.scss',
})
export class AuditLogComponent implements OnInit {
  private readonly api = inject(AuditService);

  readonly entries = signal<AuditLogEntry[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly technical = signal(false);
  readonly search = signal('');

  readonly actions = ACTIONS;

  filters: AuditFilters & { adminIdText: string } = {
    adminIdText: '',
    action: '',
    startDate: '',
    endDate: '',
  };

  /** Entradas filtradas (búsqueda client-side por recurso/detalles) y agrupadas por día. */
  readonly groups = computed<DayGroup[]>(() => {
    const q = this.search().trim().toLowerCase();
    const list = this.entries().filter((e) => {
      if (!q) return true;
      const hay = `${e.resource_type || ''} ${e.resource_id || ''} ${JSON.stringify(e.details || '')}`.toLowerCase();
      return hay.includes(q);
    });
    const byDay = new Map<string, AuditLogEntry[]>();
    for (const e of list) {
      const d = new Date(e.created_at);
      const key = d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
      const arr = byDay.get(key) || [];
      arr.push(e);
      byDay.set(key, arr);
    }
    return [...byDay.entries()].map(([day, entries]) => ({ day, entries }));
  });

  ngOnInit() {
    this.load();
  }

  load() {
    this.loading.set(true);
    this.error.set(null);
    const f: AuditFilters = {
      adminId: this.filters.adminIdText ? Number(this.filters.adminIdText) : null,
      action: this.filters.action || null,
      startDate: this.filters.startDate || null,
      endDate: this.filters.endDate || null,
    };
    this.api.list(f).subscribe({
      next: (list) => { this.entries.set(list); this.loading.set(false); },
      error: (err) => { this.error.set(errorToMessage(err, 'No se pudo cargar la actividad')); this.loading.set(false); },
    });
  }

  clearFilters() {
    this.filters = { adminIdText: '', action: '', startDate: '', endDate: '' };
    this.search.set('');
    this.load();
  }

  private det(e: AuditLogEntry): any {
    try {
      return typeof e.details === 'string' ? JSON.parse(e.details) : (e.details || {});
    } catch { return {}; }
  }

  /** Frase legible en castellano por action type. */
  describe(e: AuditLogEntry): string {
    const d = this.det(e);
    const res = e.resource_id ? `#${e.resource_id}` : '';
    switch (e.action) {
      case 'admin_login': return 'Inició sesión en el panel';
      case 'admin_login_failed': return `Intento de login fallido${d.email ? ` (${d.email})` : ''}`;
      case 'admin_logout': return 'Cerró sesión';
      case 'client.create': return `Creó el cliente ${d.name || res}`;
      case 'client.update': return `Actualizó el cliente ${res}${d.fields?.length ? ` (${d.fields.join(', ')})` : ''}`;
      case 'client.delete': return `Borró el cliente ${res}${d.sessionsDropped ? ` (${d.sessionsDropped} sesiones cerradas)` : ''}`;
      case 'client.pairing_regenerate': return `Regeneró el enlace de vinculación del cliente ${res}`;
      case 'client.set_password': return `Asignó contraseña del panel al cliente ${res}`;
      case 'client.blacklist_add': return `Añadió ${d.number || 'un número'} a la lista sin bot del cliente ${res}`;
      case 'client.blacklist_remove': return `Quitó ${d.number || 'un número'} de la lista sin bot del cliente ${res}`;
      case 'session.start': return `Inició la sesión de WhatsApp "${e.resource_id}"${d.clientId ? ` (cliente #${d.clientId})` : ''}`;
      case 'session.stop': return `Paró la sesión de WhatsApp "${e.resource_id}"`;
      case 'session.delete': return `Eliminó la sesión de WhatsApp "${e.resource_id}"`;
      case 'group.create': return `Creó el grupo "${d.subject || ''}"${d.participants ? ` (${d.participants} participantes)` : ''} desde "${e.resource_id}"`;
      case 'group.join': return `Unió el bot a un grupo por invitación desde "${e.resource_id}"`;
      case 'handoff.resume': return `Devolvió al bot el contacto ${this.phone(d.contactJid)} (cliente ${res})`;
      case 'message.send': return `Envió un mensaje manual a ${this.phone(d.to)}${d.length ? ` (${d.length} caracteres)` : ''}`;
      case 'webhook.test': return `Probó el webhook del cliente ${res}${d.status ? ` (HTTP ${d.status})` : ''}`;
      case 'panel.login': return `El cliente ${res} entró en su panel`;
      case 'panel.logout': return `El cliente ${res} cerró sesión en su panel`;
      case 'panel.bot_toggle': return `El cliente ${res} ${d.enabled ? 'encendió' : 'apagó'} su bot`;
      case 'panel.schedule_update': return `El cliente ${res} actualizó su horario (${d.windows ?? 0} franjas${d.scheduleEnabled === false ? ', horario desactivado' : ''})`;
      case 'panel.blacklist_add': return `El cliente ${res} silenció el número ${d.number || ''}`;
      case 'panel.blacklist_remove': return `El cliente ${res} reactivó el número ${d.number || ''}`;
      case 'panel.handoff_resume': return `El cliente ${res} devolvió al bot el contacto ${this.phone(d.contactJid)}`;
      case 'panel.reply_send': return `El cliente ${res} respondió a ${this.phone(d.to)}${d.length ? ` (${d.length} caracteres)` : ''}`;
      case 'panel.api_key_generate': return `El cliente ${res} generó/rotó su API key`;
      case 'panel.api_key_revoke': return `El cliente ${res} revocó su API key`;
      case 'panel.password_change': return `El cliente ${res} cambió su contraseña del panel`;
      case 'client.api_key_generate': return `Generó/rotó la API key del cliente ${res}`;
      case 'client.api_key_revoke': return `Revocó la API key del cliente ${res}`;
      case 'api.message_send': return `La API del cliente ${res} envió un mensaje a ${this.phone(d.to)}${d.media ? ' (con archivo)' : ''}`;
      case 'api.handoff_start': return `La API del cliente ${res} pausó el bot para ${this.phone(d.contactJid)}`;
      case 'api.handoff_resume': return `La API del cliente ${res} devolvió al bot el contacto ${this.phone(d.contactJid)}`;
      case 'api.group_create': return `La API del cliente ${res} creó el grupo "${d.subject || ''}"`;
      case 'api.group_join': return `La API del cliente ${res} unió el bot a un grupo`;
      case 'client.whitelist_toggle': return `${d.enabled ? 'Activó' : 'Desactivó'} la lista blanca del cliente ${res}`;
      case 'client.whitelist_add': return `Añadió ${d.number || 'un número'} a la lista blanca del cliente ${res}`;
      case 'client.whitelist_remove': return `Quitó ${d.number || 'un número'} de la lista blanca del cliente ${res}`;
      case 'panel.whitelist_toggle': return `El cliente ${res} ${d.enabled ? 'activó' : 'desactivó'} su lista blanca`;
      case 'panel.whitelist_add': return `El cliente ${res} añadió ${d.number || 'un número'} a su lista blanca`;
      case 'panel.whitelist_remove': return `El cliente ${res} quitó ${d.number || 'un número'} de su lista blanca`;
      case 'api.whitelist_toggle': return `La API del cliente ${res} ${d.enabled ? 'activó' : 'desactivó'} la lista blanca`;
      case 'api.whitelist_add': return `La API del cliente ${res} añadió ${d.number || 'un número'} a la lista blanca`;
      case 'panel.events_webhook_update': return `El cliente ${res} ${d.configured ? 'configuró' : 'desactivó'} su webhook de eventos`;
      case 'client.events_webhook_update': return `${d.configured ? 'Configuró' : 'Desactivó'} el webhook de eventos del cliente ${res}`;
      case 'api.events_webhook_update': return `La API del cliente ${res} ${d.configured ? 'configuró' : 'desactivó'} el webhook de eventos`;
      default: return `${e.action} ${e.resource_type || ''} ${res}`.trim();
    }
  }

  private phone(jid?: string): string {
    if (!jid) return 'un contacto';
    const num = String(jid).split('@')[0];
    return /^\d{6,}$/.test(num) ? `+${num}` : num;
  }

  /** Familia visual del evento (icono/color del punto del timeline). */
  family(action: string): string {
    if (action.startsWith('admin_')) return 'auth';
    if (action.startsWith('client.blacklist') || action.includes('whitelist')) return 'rule';
    if (action.startsWith('client.')) return 'client';
    if (action.startsWith('session.')) return 'session';
    if (action.startsWith('group.')) return 'session';
    if (action.startsWith('panel.')) return 'panel';
    if (action.startsWith('api.')) return 'webhook';
    if (action.startsWith('handoff.')) return 'handoff';
    if (action.startsWith('message.')) return 'message';
    if (action.startsWith('webhook.')) return 'webhook';
    return 'other';
  }

  /** Quién realizó la acción (los panel.* los hace el propio cliente, sin admin). */
  actor(e: AuditLogEntry): string {
    if (e.action?.startsWith('panel.')) return 'cliente (panel)';
    if (e.action?.startsWith('api.')) return 'API';
    return e.admin_id ? `admin #${e.admin_id}` : '—';
  }

  detailsPreview(d: any): string {
    if (!d) return '';
    try {
      const obj = typeof d === 'string' ? JSON.parse(d) : d;
      const keys = Object.keys(obj || {});
      if (!keys.length) return '';
      return keys.map((k) => `${k}=${JSON.stringify(obj[k])}`).join(' · ');
    } catch {
      return String(d);
    }
  }
}
