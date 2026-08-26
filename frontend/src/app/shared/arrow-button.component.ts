import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

/**
 * CTA primario "ink" con pastilla de doble flecha que se intercambia en hover
 * (la .ar-1 sale por la derecha, la .ar-2 entra por la izquierda).
 * Estilos de .btn-arrows/.btn-icon/.ar en styles.scss.
 *
 * Uso: <xp-arrow-btn type="submit" [disabled]="loading()">Entrar</xp-arrow-btn>
 */
@Component({
  selector: 'xp-arrow-btn',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button class="primary btn-arrows" [type]="type" [disabled]="disabled">
      <ng-content />
      <span class="btn-icon" aria-hidden="true">
        <svg class="ar ar-1" viewBox="0 0 16 16" fill="none" stroke="currentColor"
          stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 8h9M8.5 4l4 4-4 4"/>
        </svg>
        <svg class="ar ar-2" viewBox="0 0 16 16" fill="none" stroke="currentColor"
          stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 8h9M8.5 4l4 4-4 4"/>
        </svg>
      </span>
    </button>
  `,
})
export class ArrowButtonComponent {
  @Input() type: 'button' | 'submit' = 'button';
  @Input() disabled = false;
}
