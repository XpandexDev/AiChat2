'use client';

import { useEffect, useRef } from 'react';

/**
 * Red de nodos interactiva (Canvas 2D, ligera — sin three.js): nodos que
 * derivan, se enlazan por cercanía y cerca del cursor se apartan y se
 * encienden en rosa. Se pausa fuera de viewport; nada con reduced-motion.
 */
export default function HeroNodes() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const N = 54;
    const LINK = 150; // px de enlace
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let w = 0, h = 0;
    let raf = 0;
    let running = true;
    let mouse = { x: -9999, y: -9999 };

    type Node = { x: number; y: number; vx: number; vy: number; heat: number };
    let nodes: Node[] = [];

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      w = r.width;
      h = r.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!nodes.length) {
        nodes = Array.from({ length: N }, () => ({
          x: Math.random() * w,
          y: Math.random() * h,
          vx: (Math.random() - 0.5) * 0.35,
          vy: (Math.random() - 0.5) * 0.35,
          heat: 0,
        }));
      }
    };

    const step = () => {
      if (!running) return;
      ctx.clearRect(0, 0, w, h);

      for (const n of nodes) {
        // repulsión suave del cursor
        const dx = n.x - mouse.x;
        const dy = n.y - mouse.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 160 * 160) {
          const d = Math.sqrt(d2) || 1;
          const f = ((160 - d) / 160) * 0.6;
          n.vx += (dx / d) * f * 0.25;
          n.vy += (dy / d) * f * 0.25;
          n.heat = Math.min(1, n.heat + 0.08);
        } else {
          n.heat = Math.max(0, n.heat - 0.02);
        }
        // fricción + deriva
        n.vx = Math.max(-0.6, Math.min(0.6, n.vx * 0.985));
        n.vy = Math.max(-0.6, Math.min(0.6, n.vy * 0.985));
        n.x += n.vx;
        n.y += n.vy;
        if (n.x < 0 || n.x > w) n.vx *= -1;
        if (n.y < 0 || n.y > h) n.vy *= -1;
        n.x = Math.max(0, Math.min(w, n.x));
        n.y = Math.max(0, Math.min(h, n.y));
      }

      // enlaces
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d = Math.hypot(dx, dy);
          if (d < LINK) {
            const alpha = (1 - d / LINK) * 0.35;
            const heat = Math.max(a.heat, b.heat);
            ctx.strokeStyle = heat > 0.15
              ? `rgba(233, 30, 140, ${alpha * (0.4 + heat * 0.6)})`
              : `rgba(154, 163, 178, ${alpha})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      // nodos
      for (const n of nodes) {
        const r = 2 + n.heat * 1.5;
        ctx.fillStyle = n.heat > 0.1
          ? `rgba(233, 30, 140, ${0.5 + n.heat * 0.5})`
          : 'rgba(27, 31, 39, 0.55)';
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fill();
      }

      raf = requestAnimationFrame(step);
    };

    const onMouse = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onLeave = () => { mouse = { x: -9999, y: -9999 }; };

    resize();
    window.addEventListener('resize', resize, { passive: true });
    window.addEventListener('mousemove', onMouse, { passive: true });
    document.addEventListener('mouseleave', onLeave, { passive: true });

    const io = new IntersectionObserver(([entry]) => {
      const visible = entry.isIntersecting;
      if (visible && !running) { running = true; raf = requestAnimationFrame(step); }
      if (!visible) { running = false; cancelAnimationFrame(raf); }
    });
    io.observe(canvas);
    raf = requestAnimationFrame(step);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      io.disconnect();
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', onMouse);
      document.removeEventListener('mouseleave', onLeave);
    };
  }, []);

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
      <canvas ref={ref} className="h-full w-full" />
      {/* velo radial para legibilidad del texto */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(52% 46% at 50% 44%, rgba(255,255,255,.88) 0%, rgba(255,255,255,.55) 60%, transparent 100%)',
        }}
      />
      <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-b from-transparent to-[#FBFBFA]" />
    </div>
  );
}
