import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import {
  ClientPanelService, ClientMeClient, ClientSessionView, ScheduleWindow, SchedulePayload, BlacklistEntry, HandoffContact,
} from '../../core/api/client-panel.service';
import { errorToMessage } from '../../core/api/error';
import { ContactsService } from '../../core/api/contacts.service';
import { AvatarComponent } from '../../shared/avatar.component';
import { RevealDirective } from '../../shared/reveal.directive';

interface DayRow {
  weekday: number;
  label: string;
  windows: { start: string; end: string }[];
}

// Orden de visualización Lunes→Domingo (los datos usan 0=domingo..6=sábado).
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_LABELS: Record<number, string> = {
  0: 'Domingo', 1: 'Lunes', 2: 'Martes', 3: 'Miércoles', 4: 'Jueves', 5: 'Viernes', 6: 'Sábado',
};

@Component({
  selector: 'app-client-dashboard',
  standalone: true,
  imports: [FormsModule, DatePipe, RevealDirective, AvatarComponent],
  templateUrl: './client-dashboard.component.html',
  styleUrl: './client-dashboard.component.scss',
})
export class ClientDashboardComponent implements OnInit, OnDestroy {
  // Refresco suave del handoff (el panel de cliente no tiene socket).
  private handoffPoll: ReturnType<typeof setInterval> | null = null;
  private readonly api = inject(ClientPanelService);
  readonly contacts = inject(ContactsService);

  readonly timezones = [
    'Europe/Madrid', 'Atlantic/Canary', 'Europe/London', 'Europe/Lisbon',
    'America/Mexico_City', 'America/Argentina/Buenos_Aires', 'America/Bogota', 'UTC',
  ];

  readonly me = signal<ClientMeClient | null>(null);
  readonly sessions = signal<ClientSessionView[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly savingBot = signal(false);
  readonly savingSchedule = signal(false);

  // Estado del editor de horario (campos planos para [(ngModel)]).
  scheduleEnabled = false;
  timezone = 'Europe/Madrid';
  autoReplyText = '';
  readonly days = signal<DayRow[]>([]);

  // Blacklist (números sin bot)
  readonly blacklist = signal<BlacklistEntry[]>([]);
  newBlacklistNumber = '';
  newBlacklistNote = '';
  readonly savingBlacklist = signal(false);

  // Handoff (contactos con humano al mando)
  readonly handoffs = signal<HandoffContact[]>([]);
  readonly replyTarget = signal<HandoffContact | null>(null);
  replyText = '';
  readonly sendingReply = signal(false);

  ngOnInit() {
    this.load();
    this.handoffPoll = setInterval(() => this.loadHandoff(), 30000);
  }

  ngOnDestroy() {
    if (this.handoffPoll) clearInterval(this.handoffPoll);
  }

  load() {
    this.loading.set(true);
    this.api.me().subscribe({
      next: (r) => { this.me.set(r.client); this.sessions.set(r.sessions || []); this.loading.set(false); },
      error: (err) => { this.error.set(errorToMessage(err, 'No se pudo cargar el panel')); this.loading.set(false); },
    });
    this.api.getSchedule().subscribe({
      next: (s) => this.applySchedule(s),
      error: () => this.applySchedule({ scheduleEnabled: false, timezone: 'Europe/Madrid', autoReplyText: '', windows: [] }),
    });
    this.api.listBlacklist().subscribe({
      next: (l) => this.blacklist.set(l),
      error: () => this.blacklist.set([]),
    });
    this.loadHandoff();
  }

  loadHandoff() {
    this.api.listHandoff().subscribe({
      next: (l) => {
        this.handoffs.set(l);
        // Perfiles (foto/nombre/info) de los contactos en handoff
        for (const h of l) this.contacts.loadForPanel(h.contactJid);
      },
      error: () => this.handoffs.set([]),
    });
  }

  replyTo(h: HandoffContact) {
    this.replyTarget.set(h);
    this.replyText = '';
  }

  cancelReply() {
    this.replyTarget.set(null);
    this.replyText = '';
  }

  sendReply() {
    const h = this.replyTarget();
    const text = this.replyText.trim();
    if (!h || !text) return;
    const to = h.replyJid || h.contactJid;
    if (!h.sessionId || !to) { this.error.set('No hay sesión/destino para responder'); return; }
    this.sendingReply.set(true);
    this.error.set(null);
    this.api.sendReply(h.sessionId, to, text).subscribe({
      next: () => { this.sendingReply.set(false); this.replyText = ''; this.replyTarget.set(null); this.notice.set('Mensaje enviado'); },
      error: (err) => { this.sendingReply.set(false); this.error.set(errorToMessage(err, 'No se pudo enviar')); },
    });
  }

  resumeHandoff(h: HandoffContact) {
    this.api.resumeContact(h.contactJid).subscribe({
      next: () => {
        this.handoffs.set(this.handoffs().filter((x) => x.contactJid !== h.contactJid));
        if (this.replyTarget()?.contactJid === h.contactJid) this.replyTarget.set(null);
        this.notice.set('Bot reactivado para el contacto');
      },
      error: (err) => this.error.set(errorToMessage(err, 'No se pudo reactivar el bot')),
    });
  }

  contactNumber(jid: string): string {
    return (jid || '').split('@')[0];
  }

  addBlacklist() {
    const num = this.newBlacklistNumber.trim();
    if (!num) return;
    this.savingBlacklist.set(true);
    this.error.set(null);
    this.api.addBlacklist(num, this.newBlacklistNote.trim() || null).subscribe({
      next: (l) => {
        this.blacklist.set(l);
        this.newBlacklistNumber = '';
        this.newBlacklistNote = '';
        this.savingBlacklist.set(false);
        this.notice.set('Número añadido a la lista sin bot');
      },
      error: (err) => { this.savingBlacklist.set(false); this.error.set(errorToMessage(err, 'No se pudo añadir el número')); },
    });
  }

  removeBlacklist(jid: string) {
    this.api.removeBlacklist(jid).subscribe({
      next: (l) => { this.blacklist.set(l); this.notice.set('Número quitado de la lista'); },
      error: (err) => this.error.set(errorToMessage(err, 'No se pudo quitar el número')),
    });
  }

  private applySchedule(s: SchedulePayload) {
    this.scheduleEnabled = Boolean(s.scheduleEnabled);
    this.timezone = s.timezone || 'Europe/Madrid';
    this.autoReplyText = s.autoReplyText || '';
    this.days.set(DAY_ORDER.map((wd) => ({
      weekday: wd,
      label: DAY_LABELS[wd],
      windows: (s.windows || []).filter((w) => Number(w.weekday) === wd).map((w) => ({ start: w.start, end: w.end })),
    })));
  }

  toggleBot() {
    const c = this.me();
    if (!c) return;
    this.savingBot.set(true);
    this.error.set(null);
    this.api.setBot(!c.botEnabled).subscribe({
      next: (r) => {
        this.me.set({ ...c, botEnabled: r.botEnabled });
        this.savingBot.set(false);
        this.notice.set(r.botEnabled ? 'Bot activado' : 'Bot desactivado');
      },
      error: (err) => { this.savingBot.set(false); this.error.set(errorToMessage(err, 'No se pudo cambiar el bot')); },
    });
  }

  addWindow(weekday: number) {
    this.days.set(this.days().map((d) => (
      d.weekday === weekday ? { ...d, windows: [...d.windows, { start: '09:00', end: '14:00' }] } : d
    )));
  }

  removeWindow(weekday: number, idx: number) {
    this.days.set(this.days().map((d) => (
      d.weekday === weekday ? { ...d, windows: d.windows.filter((_, i) => i !== idx) } : d
    )));
  }

  // end '00:00' = fin de día (medianoche) → comparar como '24:00'.
  private endCmp(end: string): string {
    return end === '00:00' ? '24:00' : end;
  }

  saveSchedule() {
    const windows: ScheduleWindow[] = [];
    for (const d of this.days()) {
      for (const w of d.windows) {
        if (!w.start || !w.end) { this.error.set(`Completa las horas del ${d.label}`); return; }
        if (w.start >= this.endCmp(w.end)) { this.error.set(`En ${d.label}, la hora de inicio debe ser anterior a la de fin (usa 00:00 para medianoche)`); return; }
      }
      const sorted = [...d.windows].sort((a, b) => a.start.localeCompare(b.start));
      for (let i = 1; i < sorted.length; i += 1) {
        if (sorted[i].start < this.endCmp(sorted[i - 1].end)) { this.error.set(`Las franjas del ${d.label} se solapan`); return; }
      }
      for (const w of d.windows) windows.push({ weekday: d.weekday, start: w.start, end: w.end });
    }
    this.savingSchedule.set(true);
    this.error.set(null);
    this.api.saveSchedule({
      scheduleEnabled: this.scheduleEnabled,
      timezone: this.timezone,
      autoReplyText: this.autoReplyText,
      windows,
    }).subscribe({
      next: (s) => { this.applySchedule(s); this.savingSchedule.set(false); this.notice.set('Horario guardado'); },
      error: (err) => { this.savingSchedule.set(false); this.error.set(errorToMessage(err, 'No se pudo guardar el horario')); },
    });
  }

  activationUrl(): string {
    const t = this.me()?.pairingToken;
    return t ? `${window.location.origin}/connect/${t}` : '';
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
