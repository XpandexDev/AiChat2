'use client';

import { useEffect, useRef } from 'react';

/** Envoltura magnética: el CTA sigue al cursor con lerp (solo hover+pointer fine). */
export default function MagneticButton({
  children,
  strength = 0.34,
  className = '',
}: {
  children: React.ReactNode;
  strength?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!fine || reduced) return;

    let raf = 0;
    let cx = 0, cy = 0, tx = 0, ty = 0;
    const onMove = (e: MouseEvent) => {
      const r = node.getBoundingClientRect();
      tx = (e.clientX - r.left - r.width / 2) * strength;
      ty = (e.clientY - r.top - r.height / 2) * strength;
    };
    const onLeave = () => { tx = 0; ty = 0; };
    const tick = () => {
      cx += (tx - cx) * 0.18;
      cy += (ty - cy) * 0.18;
      node.style.transform =
        Math.abs(cx) + Math.abs(cy) > 0.05 ? `translate(${cx.toFixed(2)}px, ${cy.toFixed(2)}px)` : '';
      raf = requestAnimationFrame(tick);
    };
    node.addEventListener('mousemove', onMove, { passive: true });
    node.addEventListener('mouseleave', onLeave, { passive: true });
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      node.removeEventListener('mousemove', onMove);
      node.removeEventListener('mouseleave', onLeave);
    };
  }, [strength]);

  return (
    <span ref={ref} className={`inline-block will-change-transform ${className}`}>
      {children}
    </span>
  );
}
