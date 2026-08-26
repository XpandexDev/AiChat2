import Header from '@/components/Header';
import Footer from '@/components/Footer';
import HeroNodes from '@/components/HeroNodes';
import Reveal from '@/components/Reveal';
import SpotlightCard from '@/components/SpotlightCard';
import MagneticButton from '@/components/MagneticButton';
import { Arrow, Bot, Handoff, Panel, Clock, Form, Group, Qr, Brain, Check, WhatsApp, Mail } from '@/components/Icons';

const FEATURES = [
  {
    icon: Bot,
    title: 'Atiende 24/7 con tu conocimiento',
    desc: 'La IA responde con la información real de tu negocio: servicios, precios, horarios, reservas. Sin respuestas enlatadas.',
  },
  {
    icon: Handoff,
    title: 'Sabe cuándo retirarse',
    desc: 'Si la conversación necesita a una persona —una queja, un caso delicado, una venta importante—, el bot avisa y cede el control. Tú respondes y lo devuelves al bot cuando termines.',
  },
  {
    icon: Panel,
    title: 'Tu panel, tu control',
    desc: 'Enciende o apaga el bot, define su horario semanal, silencia números concretos y responde tú mismo desde un panel propio. Sin depender de nadie.',
  },
  {
    icon: Form,
    title: 'Formularios por WhatsApp',
    desc: 'Cuando hace falta recoger datos —una reserva, un pedido, un alta—, el bot envía un formulario y las respuestas llegan directas a tu flujo.',
  },
  {
    icon: Group,
    title: 'Entiende los grupos',
    desc: 'En grupos de WhatsApp distingue quién habla y responde con contexto compartido, identificando a cada persona.',
  },
  {
    icon: Brain,
    title: 'Memoria por conversación',
    desc: 'Cada contacto tiene su hilo: el bot recuerda lo hablado y retoma la conversación donde se quedó. Nada de repetir tu historia.',
  },
];

const STEPS = [
  {
    icon: Qr,
    title: 'Conecta tu número',
    desc: 'Escaneas un QR desde tu página de activación y tu WhatsApp queda vinculado. Sin cambiar de número ni de app.',
  },
  {
    icon: Brain,
    title: 'Entrenamos tu IA',
    desc: 'Cargamos el conocimiento de tu negocio: qué vendes, cómo trabajas, qué preguntan tus clientes y cómo quieres responder.',
  },
  {
    icon: Bot,
    title: 'El bot atiende',
    desc: 'Responde al momento, a cualquier hora, con tu tono. Agenda, resuelve dudas y recoge datos con formularios.',
  },
  {
    icon: Handoff,
    title: 'Tú supervisas',
    desc: 'Desde tu panel ves las conversaciones, tomas el control cuando quieres y el bot te deriva los casos que lo necesitan.',
  },
];

export default function Home() {
  return (
    <>
      <Header />

      {/* ============ HERO ============ */}
      <section className="relative flex min-h-[100svh] items-center justify-center overflow-hidden bg-white">
        <HeroNodes />
        <div className="mx-auto w-full max-w-content px-6 pb-14 pt-28">
          <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
            <span className="chip hero-in d1">
              <span className="dot" />
              IA para WhatsApp · by Xpandex
            </span>
            <h1 className="hero-in-shift mt-6 max-w-[16ch] font-display text-[2.7rem] font-bold leading-[1.08] tracking-[-0.03em] text-brand-ink sm:text-[3.6rem] lg:text-[4.5rem]">
              Un chatbot de <span className="text-brand-pink">WhatsApp</span> que atiende como tu mejor empleado
            </h1>
            <p className="hero-in d2 mt-6 max-w-xl text-[17px] leading-relaxed text-brand-ink-2 sm:text-[18px]">
              Responde al momento, 24/7, con el conocimiento de tu negocio. Agenda citas,
              recoge pedidos y —cuando hace falta— te pasa la conversación a ti.
            </p>
            <div className="hero-in d3 mt-9 flex flex-wrap items-center justify-center gap-3">
              <MagneticButton>
                <a href="#contacto" className="btn-ink h-[54px] pl-7 pr-2.5 text-[15px]">
                  Quiero mi chatbot
                  <span className="btn-icon">
                    <Arrow className="ar ar-1 h-4 w-4" />
                    <Arrow className="ar ar-2 h-4 w-4" />
                  </span>
                </a>
              </MagneticButton>
              <MagneticButton>
                <a href="#como-funciona" className="btn-line h-[54px] px-7 text-[15px]">
                  Cómo funciona
                  <Arrow className="ar h-4 w-4" />
                </a>
              </MagneticButton>
            </div>
            <p className="hero-in d4 mt-8 font-mono text-[12px] uppercase tracking-[0.14em] text-brand-ink-3">
              Sin apps nuevas · Tu número de siempre · Handoff a humano
            </p>
          </div>
        </div>
      </section>

      {/* ============ CARACTERÍSTICAS (bento) ============ */}
      <section id="caracteristicas" className="relative scroll-mt-24 bg-brand-canvas pb-20 pt-12 md:pb-28 md:pt-16">
        <div className="aurora" aria-hidden />
        <div className="mx-auto max-w-content px-6">
          <Reveal className="mx-auto max-w-2xl text-center">
            <span className="chip">
              <span className="dot" />
              Características
            </span>
            <h2 className="mt-5 font-display text-3xl font-bold leading-[1.12] tracking-[-0.02em] text-brand-ink sm:text-4xl lg:text-[2.9rem]">
              Todo lo que esperas de un buen <span className="text-brand-pink">empleado</span>
            </h2>
            <p className="mt-4 text-[16px] leading-relaxed text-brand-ink-2">
              No es un contestador con menús. Es una IA entrenada con tu negocio, con las
              herramientas para atender de verdad.
            </p>
          </Reveal>

          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f, i) => (
              <Reveal key={f.title} delay={(i % 3) * 80}>
                <SpotlightCard className="tile h-full p-8">
                  <div className="grid h-10 w-10 place-items-center rounded-xl bg-black/[0.05] text-brand-ink">
                    <f.icon className="h-5 w-5" />
                  </div>
                  <h3 className="mt-5 font-display text-xl font-semibold leading-[1.2] text-brand-ink">
                    {f.title}
                  </h3>
                  <p className="mt-3 text-[15px] leading-relaxed text-brand-ink-2">{f.desc}</p>
                </SpotlightCard>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ============ CÓMO FUNCIONA ============ */}
      <section id="como-funciona" className="relative scroll-mt-24 bg-white py-20 md:py-28">
        <div className="techgrid" aria-hidden />
        <div className="mx-auto max-w-content px-6">
          <Reveal className="mx-auto max-w-2xl text-center">
            <span className="chip">
              <span className="dot" />
              Cómo funciona
            </span>
            <h2 className="mt-5 font-display text-3xl font-bold leading-[1.12] tracking-[-0.02em] text-brand-ink sm:text-4xl lg:text-[2.9rem]">
              En marcha en <span className="text-brand-pink">días</span>, no en meses
            </h2>
          </Reveal>

          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s, i) => (
              <Reveal key={s.title} delay={i * 80}>
                <div className="tile h-full p-7">
                  <div className="flex items-center gap-3">
                    <span className="grid h-8 w-8 flex-none place-items-center rounded-full bg-gradient-to-br from-[#e91e8c] to-[#d4187e] font-display text-[0.85rem] font-bold text-white shadow-[0_4px_12px_rgba(233,30,140,.22)]">
                      {i + 1}
                    </span>
                    <s.icon className="h-5 w-5 text-brand-ink-3" />
                  </div>
                  <h3 className="mt-4 font-display text-lg font-semibold leading-[1.2] text-brand-ink">
                    {s.title}
                  </h3>
                  <p className="mt-2.5 text-[14px] leading-relaxed text-brand-ink-2">{s.desc}</p>
                </div>
              </Reveal>
            ))}
          </div>

          <Reveal className="mt-10">
            <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-center gap-x-6 gap-y-2 font-mono text-[12px] text-brand-ink-3">
              {['Multi-cliente', 'Horario del bot', 'Lista de silenciados', 'Aviso fuera de horario'].map((t) => (
                <span key={t} className="inline-flex items-center gap-1.5">
                  <Check className="h-3.5 w-3.5 text-brand-pink" />
                  {t}
                </span>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      {/* ============ CTA OSCURA / CONTACTO ============ */}
      <section id="contacto" className="section-dark relative scroll-mt-24 overflow-hidden py-20 md:py-28">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-white/10 blur-[80px]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-32 -left-24 h-96 w-96 rounded-full bg-[#e91e8c]/20 blur-[80px]"
        />
        <div className="mx-auto max-w-content px-6">
          <div className="mx-auto grid max-w-4xl items-center gap-10 md:grid-cols-2">
            <Reveal>
              <span className="section-label !text-white/60">Contacto</span>
              <h2 className="mt-4 font-display text-3xl font-bold leading-[1.12] tracking-[-0.02em] text-white sm:text-4xl">
                ¿Ponemos tu WhatsApp a <span className="text-brand-pink">trabajar</span>?
              </h2>
              <p className="mt-4 max-w-md text-[16px] leading-relaxed text-white/70">
                Cuéntanos qué hace tu negocio y te enseñamos el bot funcionando con tus
                propios casos. Sin permanencia y sin humo.
              </p>
            </Reveal>
            <Reveal delay={120}>
              <div className="glass-card p-7">
                <p className="flex items-center gap-2 text-[13px] text-white/70">
                  <span className="inline-block h-2 w-2 rounded-full bg-brand-pink" />
                  Respuesta hoy mismo
                </p>
                <div className="mt-5 grid gap-3">
                  <a
                    href="mailto:info@xpandex.es?subject=Quiero%20mi%20chatbot%20de%20WhatsApp"
                    className="btn-ink h-[52px] w-full pl-6 pr-2.5 text-[15px] !bg-white !text-brand-ink !shadow-none hover:!bg-white/90"
                    style={{ background: '#fff' }}
                  >
                    <Mail className="h-4 w-4" />
                    info@xpandex.es
                    <span className="btn-icon !bg-black/[0.08]">
                      <Arrow className="ar ar-1 h-4 w-4" />
                      <Arrow className="ar ar-2 h-4 w-4" />
                    </span>
                  </a>
                  <a
                    href="https://xpandex.es"
                    target="_blank"
                    rel="noopener"
                    className="btn-line h-[52px] w-full !border-white/20 !bg-transparent px-6 text-[15px] !text-white"
                  >
                    <WhatsApp className="h-4 w-4" />
                    Conócenos · xpandex.es
                  </a>
                </div>
                <p className="mt-4 text-center font-mono text-[11px] uppercase tracking-[0.14em] text-white/40">
                  Demo con tus casos reales
                </p>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      <Footer />
    </>
  );
}
