import { Directive, ElementRef, Input, NgZone, OnDestroy, OnInit, inject } from '@angular/core';

/**
 * Efecto imán al cursor (lerp con muelle) para CTAs principales.
 * Aplica transform al host, así no choca con los estados hover del botón hijo.
 * Solo hover+pointer fine; respeta prefers-reduced-motion.
 *
 * Uso: <span xpMagnetic><button class="primary">…</button></span>
 */
@Directive({
  selector: '[xpMagnetic]',
  standalone: true,
})
export class MagneticDirective implements OnInit, OnDestroy {
  @Input() strength = 0.34;

  private readonly el = inject(ElementRef<HTMLElement>);
  private readonly zone = inject(NgZone);
  private raf = 0;
  private cx = 0;
  private cy = 0;
  private tx = 0;
  private ty = 0;
  private active = false;

  private onMove = (e: MouseEvent) => {
    const rect = this.el.nativeElement.getBoundingClientRect();
    this.tx = (e.clientX - rect.left - rect.width / 2) * this.strength;
    this.ty = (e.clientY - rect.top - rect.height / 2) * this.strength;
  };
  private onLeave = () => {
    this.tx = 0;
    this.ty = 0;
  };

  ngOnInit(): void {
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!fine || reduced) return;

    const node = this.el.nativeElement;
    node.style.display ||= 'inline-block';
    node.style.willChange = 'transform';
    this.active = true;

    this.zone.runOutsideAngular(() => {
      node.addEventListener('mousemove', this.onMove, { passive: true });
      node.addEventListener('mouseleave', this.onLeave, { passive: true });
      const tick = () => {
        if (!this.active) return;
        this.cx += (this.tx - this.cx) * 0.18;
        this.cy += (this.ty - this.cy) * 0.18;
        node.style.transform =
          Math.abs(this.cx) + Math.abs(this.cy) > 0.05
            ? `translate(${this.cx.toFixed(2)}px, ${this.cy.toFixed(2)}px)`
            : '';
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    });
  }

  ngOnDestroy(): void {
    this.active = false;
    cancelAnimationFrame(this.raf);
    this.el.nativeElement.removeEventListener('mousemove', this.onMove);
    this.el.nativeElement.removeEventListener('mouseleave', this.onLeave);
  }
}
