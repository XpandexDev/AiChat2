import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ClientPanelService, ClientMeClient, PanelApiKeyInfo } from '../../core/api/client-panel.service';
import { errorToMessage } from '../../core/api/error';
import { RevealDirective } from '../../shared/reveal.directive';

/**
 * Ajustes del panel de cliente: API (key + configuración) y Cuenta
 * (datos + cambio de contraseña self-service).
 */
@Component({
  selector: 'app-client-settings',
  standalone: true,
  imports: [FormsModule, DatePipe, RouterLink, RevealDirective],
  templateUrl: './client-settings.component.html',
  styleUrl: './client-settings.component.scss',
})
export class ClientSettingsComponent implements OnInit {
  private readonly api = inject(ClientPanelService);

  readonly me = signal<ClientMeClient | null>(null);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);

  // --- API keys (varias) + webhook de eventos ---
  readonly apiKeys = signal<PanelApiKeyInfo[]>([]);
  readonly newApiKey = signal<string | null>(null);
  readonly apiKeyBusy = signal(false);
  newKeyName = '';
  eventsUrl = '';
  readonly eventsSecret = signal<string | null>(null);
  readonly savingEvents = signal(false);

  // --- Contraseña ---
  currentPassword = '';
  newPassword = '';
  repeatPassword = '';
  readonly savingPassword = signal(false);

  readonly apiBase = `${window.location.origin}/api/v1`;

  ngOnInit() {
    this.loadApiKeys();
    this.loadEventsWebhook();
    this.api.me().subscribe({
      next: (r) => this.me.set(r.client),
      error: (err) => this.error.set(errorToMessage(err, 'No se pudieron cargar los ajustes')),
    });
  }

  loadApiKeys() {
    this.api.listApiKeys().subscribe({
      next: (list) => this.apiKeys.set(list),
      error: () => this.apiKeys.set([]),
    });
  }

  loadEventsWebhook() {
    this.api.getEventsWebhook().subscribe({
      next: (cfg) => { this.eventsUrl = cfg.url || ''; this.eventsSecret.set(cfg.secret); },
      error: () => {},
    });
  }

  curlExample(): string {
    const key = this.newApiKey() || 'xpk_TU_API_KEY';
    return `curl ${this.apiBase}/me \\\n  -H "Authorization: Bearer ${key}"`;
  }

  createApiKey() {
    const name = this.newKeyName.trim() || 'key';
    this.apiKeyBusy.set(true);
    this.error.set(null);
    this.api.createApiKey(name).subscribe({
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

  deleteApiKey(k: PanelApiKeyInfo) {
    if (!confirm(`¿Eliminar la key "${k.name}" (${k.prefix}…)? Las integraciones que la usen dejarán de funcionar.`)) return;
    this.api.deleteApiKey(k.id).subscribe({
      next: () => { this.loadApiKeys(); this.notice.set('Key eliminada'); },
      error: (err) => this.error.set(errorToMessage(err, 'No se pudo eliminar')),
    });
  }

  saveEventsWebhook(regenerate = false) {
    this.savingEvents.set(true);
    this.error.set(null);
    this.api.setEventsWebhook(this.eventsUrl.trim(), regenerate).subscribe({
      next: (cfg) => {
        this.savingEvents.set(false);
        this.eventsUrl = cfg.url || '';
        this.eventsSecret.set(cfg.secret);
        this.notice.set(cfg.url ? 'Webhook de eventos guardado' : 'Webhook de eventos desactivado');
      },
      error: (err) => { this.savingEvents.set(false); this.error.set(errorToMessage(err, 'No se pudo guardar')); },
    });
  }

  changePassword() {
    this.error.set(null);
    if (this.newPassword.length < 8) {
      this.error.set('La contraseña nueva debe tener al menos 8 caracteres');
      return;
    }
    if (this.newPassword !== this.repeatPassword) {
      this.error.set('Las contraseñas nuevas no coinciden');
      return;
    }
    this.savingPassword.set(true);
    this.api.changePassword(this.currentPassword, this.newPassword).subscribe({
      next: () => {
        this.savingPassword.set(false);
        this.currentPassword = '';
        this.newPassword = '';
        this.repeatPassword = '';
        this.notice.set('Contraseña actualizada. El resto de sesiones se han cerrado.');
      },
      error: (err) => {
        this.savingPassword.set(false);
        this.error.set(errorToMessage(err, 'No se pudo cambiar la contraseña'));
      },
    });
  }
}
