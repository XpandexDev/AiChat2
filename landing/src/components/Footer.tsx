export default function Footer() {
  return (
    <footer className="border-t border-black/[0.06] bg-white">
      <div className="mx-auto max-w-[1200px] px-5 py-10 md:px-8 md:py-14">
        <div className="flex flex-col items-start justify-between gap-8 md:flex-row md:items-center">
          <div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/xpandex-wordmark.png" alt="Xpandex" className="h-6 w-auto" />
            <p className="mt-3 max-w-xs text-[13px] leading-relaxed text-gray-500">
              Agencia de automatización e IA. Chatbots de WhatsApp que atienden tu negocio
              como tu mejor empleado.
            </p>
          </div>
          <nav className="grid gap-2 text-[13px] text-gray-500">
            <span className="font-display text-[11px] font-bold uppercase tracking-wider text-gray-700">
              Xpandex
            </span>
            <a className="hover:text-gray-900" href="https://xpandex.es" target="_blank" rel="noopener">
              xpandex.es
            </a>
            <a className="hover:text-gray-900" href="mailto:info@xpandex.es">
              info@xpandex.es
            </a>
            <a className="hover:text-gray-900" href="#caracteristicas">
              Características
            </a>
          </nav>
        </div>
        <div className="mt-10 border-t border-black/[0.06] pt-6">
          <p className="text-[12px] text-gray-400">
            © {new Date().getFullYear()} Xpandex. Todos los derechos reservados.
          </p>
        </div>
      </div>
    </footer>
  );
}
