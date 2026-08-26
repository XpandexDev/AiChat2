'use client';

import { useEffect, useRef } from 'react';

/**
 * Scroll-reveal auto-armado: monta visible y, solo si hay motion permitido,
 * se arma (oculta) y se revela al entrar en vista. CSS en globals.css.
 */
export default function Reveal({
  children,
  delay = 0,
  className = '',
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const small = window.matchMedia('(max-width: 820px)').matches;
    if (reduced || small || !('IntersectionObserver' in window)) return;

    node.classList.add('reveal-armed');
    if (delay > 0) node.style.transitionDelay = `${delay}ms`;

    const show = () => node.classList.add('is-in');

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            show();
            io.disconnect();
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
    );
    io.observe(node);

    // Salvavidas: si ya está en viewport al armar (p.ej. llegada directa por
    // ancla #seccion), se revela de inmediato — nunca queda oculto.
    const r = node.getBoundingClientRect();
    if (r.top < window.innerHeight && r.bottom > 0) show();

    return () => io.disconnect();
  }, [delay]);

  return (
    <div ref={ref} data-reveal className={className}>
      {children}
    </div>
  );
}
