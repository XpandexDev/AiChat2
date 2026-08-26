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
  'handoff.resume', 'message.send', 'webhook.test',
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
      case 'handoff.resume': return `Devolvió al bot el contacto ${this.phone(d.contactJid)} (cliente ${res})`;
      case 'message.send': return `Envió un mensaje manual a ${this.phone(d.to)}${d.length ? ` (${d.length} caracteres)` : ''}`;
      case 'webhook.test': return `Probó el webhook del cliente ${res}${d.status ? ` (HTTP ${d.status})` : ''}`;
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
    if (action.startsWith('client.blacklist')) return 'rule';
    if (action.startsWith('client.')) return 'client';
    if (action.startsWith('session.')) return 'session';
    if (action.startsWith('handoff.')) return 'handoff';
    if (action.startsWith('message.')) return 'message';
    if (action.startsWith('webhook.')) return 'webhook';
    return 'other';
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
