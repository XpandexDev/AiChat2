import { ChangeDetectionStrategy, Component, Input, computed, signal } from '@angular/core';
import { DatePipe } from '@angular/common';

/**
 * Estado del historial de una sesión, SIEMPRE visible.
 * WhatsApp solo envía el lote de conversaciones al vincular un número, así que
 * el "sincronizando" dura segundos: este badge responde también después.
 */
@Component({
  selector: 'xp-history-badge',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe],
  template: `
    @if (syncing) {
      <span class="badge info" title="Importando las conversaciones que envía WhatsApp al vincular">
        Sincronizando historial{{ progress != null ? ' ' + progress + '%' : '…' }}
      </span>
    } @else if (state === 'imported') {
      <span class="badge ok"
        title="Se importaron las conversaciones recientes al vincular este número">
        Historial importado{{ messages ? ' · ' + messages + ' msg' : '' }}
      </span>
      @if (syncedAt) {
        <span class="dim small">{{ syncedAt | date: 'short' }}</span>
      }
    } @else {
      <span class="badge mute"
        title="WhatsApp solo envía el historial al vincular un número. Este se vinculó sin importarlo: el historial se irá construyendo con los mensajes nuevos.">
        Sin historial previo
      </span>
    }
  `,
})
export class HistoryBadgeComponent {
  @Input() state: string | null | undefined = 'none';
  @Input() messages = 0;
  @Input() syncedAt: string | null | undefined = null;
  @Input() syncing = false;
  @Input() progress: number | null | undefined = null;
}
