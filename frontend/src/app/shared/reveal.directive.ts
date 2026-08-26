import { Directive, ElementRef, Input, OnDestroy, OnInit, inject } from '@angular/core';

/**
 * Scroll-reveal sutil (blur + translateY + scale) al entrar en viewport.
 * Contenido VISIBLE por defecto: solo se "arma" (oculta) si hay JS y el
 * usuario no prefiere reducir el movimiento. Estilos en styles.scss
 * ([data-reveal].reveal-armed / .is-in).
 *
 * Uso: <section class="card" xpReveal [revealDelay]="80">…
 */
@Directive({
  selector: '[xpReveal]',
  standalone: true,
})
export class RevealDirective implements OnInit, OnDestroy {
  @Input() revealDelay = 0; // ms, para stagger

  private readonly el = inject(ElementRef<HTMLElement>);
  private observer: IntersectionObserver | null = null;

  ngOnInit(): void {
    const node = this.el.nativeElement;
    node.setAttribute('data-reveal', '');

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const small = window.matchMedia('(max-width: 820px)').matches;
    if (reduced || small || !('IntersectionObserver' in window)) return;

    node.classList.add('reveal-armed');
    if (this.revealDelay > 0) node.style.transitionDelay = `${this.revealDelay}ms`;

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            node.classList.add('is-in');
            this.observer?.disconnect();
            this.observer = null;
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
    );
    this.observer.observe(node);
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }
}
