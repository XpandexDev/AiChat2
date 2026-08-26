import { Component, Input, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { PairingService, PairingView } from '../../core/api/pairing.service';
import { errorToMessage } from '../../core/api/error';
import { SpotlightDirective } from '../../shared/spotlight.directive';

@Component({
  selector: 'app-onboard',
  standalone: true,
  imports: [SpotlightDirective],
  templateUrl: './onboard.component.html',
  styleUrl: './onboard.component.scss',
})
export class OnboardComponent implements OnInit, OnDestroy {
  @Input() token?: string;

  private readonly api = inject(PairingService);

  readonly view = signal<PairingView | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly starting = signal(false);

  private pollTimer: any = null;

  // El paso "primary" es la sesión más relevante para mostrar (la viva).
  readonly primarySession = computed(() => {
    const v = this.view();
    if (!v?.sessions?.length) return null;
    // Priorizamos: ready > waiting_qr_scan > starting > otras
    const order: Record<string, number> = {
      ready: 1, authenticated: 2, waiting_qr_scan: 3, starting: 4,
      disconnected: 5, auth_failure: 6, error: 7, stopped: 8,
    };
    return [...v.sessions].sort((a, b) => (order[a.status] || 99) - (order[b.status] || 99))[0];
  });

  ngOnInit() {
    if (!this.token) {
      this.error.set('Enlace no válido');
      this.loading.set(false);
      return;
    }
    this.refresh();
    // Polling cada 2s mientras el componente está montado
    this.pollTimer = setInterval(() => this.refresh(true), 2000);
  }

  ngOnDestroy() {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  refresh(silent = false) {
    if (!this.token) return;
    if (!silent) this.loading.set(true);
    this.api.fetch(this.token).subscribe({
      next: (v) => {
        this.view.set(v);
        this.error.set(null);
        this.loading.set(false);
      },
      error: (err) => {
        if (!silent) {
          this.error.set(errorToMessage(err, 'No se pudo cargar el enlace de vinculación'));
        }
        this.loading.set(false);
      },
    });
  }

  startSession() {
    if (!this.token || this.starting()) return;
    this.starting.set(true);
    this.error.set(null);
    this.api.startSession(this.token).subscribe({
      next: (v) => {
        this.view.set(v);
        this.starting.set(false);
      },
      error: (err) => {
        this.error.set(errorToMessage(err, 'No se pudo iniciar la sesión'));
        this.starting.set(false);
      },
    });
  }

  // Helpers visuales

  statusLabel(status: string | undefined): string {
    if (!status) return '';
    const m: Record<string, string> = {
      starting: 'Preparando tu código…',
      waiting_qr_scan: 'Listo para escanear',
      authenticated: 'Verificando…',
      ready: '¡Conectado!',
      disconnected: 'Reconectando…',
      auth_failure: 'Sesión rechazada',
      error: 'Error',
      stopped: 'Detenido',
    };
    return m[status] || status;
  }

  statusKind(status: string | undefined): 'idle' | 'progress' | 'ready' | 'error' {
    switch (status) {
      case 'ready': case 'authenticated': return 'ready';
      case 'waiting_qr_scan': case 'starting': case 'disconnected': return 'progress';
      case 'auth_failure': case 'error': return 'error';
      default: return 'idle';
    }
  }

  formatPhone(num: string | null): string {
    if (!num) return '';
    // Si viene como 34xxxxxxxxx, formatear con espacios
    const digits = num.replace(/\D/g, '');
    if (digits.length >= 10) {
      return '+' + digits.replace(/(\d{2})(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3 $4');
    }
    return '+' + digits;
  }
}
