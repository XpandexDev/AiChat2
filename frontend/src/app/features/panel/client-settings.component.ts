import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ClientPanelService, ClientMeClient } from '../../core/api/client-panel.service';
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

  // --- API key ---
  readonly newApiKey = signal<string | null>(null); // visible solo tras generar
  readonly apiKeyBusy = signal(false);

  // --- Contraseña ---
  currentPassword = '';
  newPassword = '';
  repeatPassword = '';
  readonly savingPassword = signal(false);

  readonly apiBase = `${window.location.origin}/api/v1`;

  ngOnInit() {
    this.api.me().subscribe({
      next: (r) => this.me.set(r.client),
      error: (err) => this.error.set(errorToMessage(err, 'No se pudieron cargar los ajustes')),
    });
  }

  curlExample(): string {
    const key = this.newApiKey() || 'xpk_TU_API_KEY';
    return `curl ${this.apiBase}/me \\\n  -H "Authorization: Bearer ${key}"`;
  }

  generateApiKey() {
    const c = this.me();
    if (!c) return;
    if (c.apiKeyPrefix && !confirm('¿Generar una key NUEVA? La anterior dejará de funcionar al instante en todas tus integraciones.')) return;
    this.apiKeyBusy.set(true);
    this.error.set(null);
    this.api.generateApiKey().subscribe({
      next: (r) => {
        this.apiKeyBusy.set(false);
        this.newApiKey.set(r.apiKey);
        this.me.set({ ...c, apiKeyPrefix: r.apiKeyPrefix, apiKeyCreatedAt: new Date().toISOString() });
      },
      error: (err) => { this.apiKeyBusy.set(false); this.error.set(errorToMessage(err, 'No se pudo generar la key')); },
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

  revokeApiKey() {
    const c = this.me();
    if (!c) return;
    if (!confirm('¿Revocar la API key? Tus integraciones dejarán de funcionar hasta que generes otra.')) return;
    this.apiKeyBusy.set(true);
    this.api.revokeApiKey().subscribe({
      next: () => {
        this.apiKeyBusy.set(false);
        this.newApiKey.set(null);
        this.me.set({ ...c, apiKeyPrefix: null, apiKeyCreatedAt: null });
        this.notice.set('API key revocada');
      },
      error: (err) => { this.apiKeyBusy.set(false); this.error.set(errorToMessage(err, 'No se pudo revocar')); },
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
