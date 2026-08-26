'use client';

import { useEffect, useState } from 'react';

const NAV = [
  { href: '#caracteristicas', label: 'Características' },
  { href: '#como-funciona', label: 'Cómo funciona' },
  { href: '#contacto', label: 'Contacto' },
];

export default function Header() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header className={`fixed top-0 z-50 flex w-full justify-center px-4 transition-all duration-[450ms] ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none ${scrolled ? 'py-2' : 'py-3 md:py-4'}`}>
      <div
        className={`w-full max-w-6xl rounded-2xl border border-black/[0.06] backdrop-saturate-150 transition-all duration-[450ms] ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none ${
          open
            ? 'bg-white'
            : scrolled
              ? 'bg-white/72 backdrop-blur-2xl shadow-[0_12px_44px_rgba(0,0,0,.12)]'
              : 'bg-white/66 backdrop-blur-xl shadow-[0_4px_22px_rgba(0,0,0,.05)]'
        }`}
      >
        <div className="flex h-12 items-center justify-between px-3 md:h-14 md:px-5">
          <a href="#" className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/xpandex-wordmark.png" alt="Xpandex" className="h-6 w-auto md:h-7" />
            <span className="chip !hidden !px-2.5 !py-1 min-[520px]:!inline-flex">AiChat</span>
          </a>

          <nav className="hidden items-center gap-1 min-[820px]:flex">
            {NAV.map((n) => (
              <a
                key={n.href}
                href={n.href}
                className="rounded-full px-3 py-2 text-[13px] font-medium text-gray-500 transition-colors hover:bg-black/[0.05] hover:text-gray-900"
              >
                {n.label}
              </a>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            <a
              href="#contacto"
              className="btn-ink hidden h-9 px-4 text-[13px] min-[820px]:inline-flex"
            >
              Quiero mi chatbot
            </a>
            <button
              type="button"
              aria-label="Menú"
              className="grid h-9 w-9 place-items-center rounded-xl border border-black/[0.06] min-[820px]:hidden"
              onClick={() => setOpen((v) => !v)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-5 w-5">
                {open ? <path d="M6 6l12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
              </svg>
            </button>
          </div>
        </div>

        {open && (
          <nav className="grid gap-1 border-t border-black/[0.06] p-3 min-[820px]:hidden">
            {NAV.map((n) => (
              <a
                key={n.href}
                href={n.href}
                onClick={() => setOpen(false)}
                className="rounded-xl px-3 py-2.5 text-[14px] font-medium text-gray-700 hover:bg-black/[0.04]"
              >
                {n.label}
              </a>
            ))}
            <a href="#contacto" onClick={() => setOpen(false)} className="btn-ink mt-1 h-11 text-[14px]">
              Quiero mi chatbot
            </a>
          </nav>
        )}
      </div>
    </header>
  );
}
