import { ChangeDetectionStrategy, Component, Input, computed, signal } from '@angular/core';

/**
 * Avatar de contacto: foto si hay URL (y carga bien), iniciales si no.
 * Estilos .avatar en styles.scss.
 *
 * Uso: <xp-avatar [url]="p?.pictureUrl" [name]="conv.senderName" [size]="36" />
 */
@Component({
  selector: 'xp-avatar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (url && !failed()) {
      <img class="avatar" [src]="url" [style.width.px]="size" [style.height.px]="size"
        alt="" (error)="failed.set(true)" />
    } @else {
      <span class="avatar avatar-initials" [style.width.px]="size" [style.height.px]="size"
        [style.fontSize.px]="size * 0.38">{{ initials() }}</span>
    }
  `,
})
export class AvatarComponent {
  @Input() url: string | null | undefined;
  @Input() name: string | null | undefined;
  @Input() size = 36;

  readonly failed = signal(false);

  readonly initials = computed(() => {
    const n = (this.name || '').trim();
    if (!n) return '·';
    const parts = n.split(/\s+/);
    const chars = ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase();
    return /^[+\d]/.test(chars) ? '#' : chars || '·';
  });
}
