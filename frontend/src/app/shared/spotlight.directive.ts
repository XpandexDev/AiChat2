import { Directive, ElementRef, NgZone, OnDestroy, OnInit, inject } from '@angular/core';

/**
 * Glow radial rosa que sigue al cursor sobre la card (estilo Linear/Vercel).
 * Solo en dispositivos con hover real + puntero fino; nada en táctil.
 *
 * Uso: <section class="card" xpSpotlight>…
 */
@Directive({
  selector: '[xpSpotlight]',
  standalone: true,
})
export class SpotlightDirective implements OnInit, OnDestroy {
  private readonly el = inject(ElementRef<HTMLElement>);
  private readonly zone = inject(NgZone);
  private glow: HTMLElement | null = null;
  private onMove = (e: MouseEvent) => {
    const rect = this.el.nativeElement.getBoundingClientRect();
    this.el.nativeElement.style.setProperty('--mx', `${e.clientX - rect.left}px`);
    this.el.nativeElement.style.setProperty('--my', `${e.clientY - rect.top}px`);
  };

  ngOnInit(): void {
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!fine || reduced) return;

    const node = this.el.nativeElement;
    node.style.position ||= 'relative';
    node.style.overflow = 'hidden';

    this.glow = document.createElement('span');
    this.glow.setAttribute('aria-hidden', 'true');
    Object.assign(this.glow.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      opacity: '0',
      transition: 'opacity .3s ease',
      background:
        'radial-gradient(240px circle at var(--mx) var(--my), rgba(233,30,140,.09), transparent 62%)',
    } satisfies Partial<CSSStyleDeclaration>);
    node.prepend(this.glow);

    this.zone.runOutsideAngular(() => {
      node.addEventListener('mousemove', this.onMove, { passive: true });
      node.addEventListener('mouseenter', () => this.glow && (this.glow.style.opacity = '1'), { passive: true });
      node.addEventListener('mouseleave', () => this.glow && (this.glow.style.opacity = '0'), { passive: true });
    });
  }

  ngOnDestroy(): void {
    this.el.nativeElement.removeEventListener('mousemove', this.onMove);
    this.glow?.remove();
  }
}
