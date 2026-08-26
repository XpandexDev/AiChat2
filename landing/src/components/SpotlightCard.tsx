'use client';

import { useEffect, useRef } from 'react';

/**
 * Card con glow radial rosa que sigue al cursor + tilt 3D sutil.
 * Solo en hover+pointer fine; en táctil es una card estática.
 */
export default function SpotlightCard({
  children,
  className = '',
  tilt = true,
}: {
  children: React.ReactNode;
  className?: string;
  tilt?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const glowRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const node = ref.current;
    const glow = glowRef.current;
    if (!node || !glow) return;
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!fine || reduced) return;

    const onMove = (e: MouseEvent) => {
      const r = node.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      glow.style.background = `radial-gradient(240px circle at ${x}px ${y}px, rgba(233,30,140,.09), transparent 62%)`;
      if (tilt) {
        const px = x / r.width;
        const py = y / r.height;
        node.style.transform = `perspective(900px) rotateX(${((0.5 - py) * 7).toFixed(2)}deg) rotateY(${((px - 0.5) * 7).toFixed(2)}deg)`;
      }
    };
    const onEnter = () => { glow.style.opacity = '1'; };
    const onLeave = () => {
      glow.style.opacity = '0';
      node.style.transform = '';
    };
    node.addEventListener('mousemove', onMove, { passive: true });
    node.addEventListener('mouseenter', onEnter, { passive: true });
    node.addEventListener('mouseleave', onLeave, { passive: true });
    return () => {
      node.removeEventListener('mousemove', onMove);
      node.removeEventListener('mouseenter', onEnter);
      node.removeEventListener('mouseleave', onLeave);
    };
  }, [tilt]);

  return (
    <div ref={ref} className={`relative overflow-hidden ${className}`}>
      <span
        ref={glowRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300"
      />
      {children}
    </div>
  );
}
