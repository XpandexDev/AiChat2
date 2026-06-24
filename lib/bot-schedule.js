// ¿Está el bot de un cliente activo AHORA? Considera el on/off manual y el
// horario semanal por franjas en la zona horaria del cliente. Sin dependencias:
// usa Intl para resolver weekday + hora local (incluido DST) en esa timezone.

const WEEKDAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Devuelve { weekday: 0-6 (0=domingo), hhmm: 'HH:MM' } de `now` en `timezone`.
// Si la timezone es inválida, lanza RangeError (el caller decide fail-open).
function nowInTz(timezone, now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'Europe/Madrid',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const wdName = parts.find((p) => p.type === 'weekday')?.value;
  let hh = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
  if (hh === '24') hh = '00'; // algunos runtimes dan '24' a medianoche con hour12:false
  return { weekday: WEEKDAY_MAP[wdName] ?? 0, hhmm: `${hh}:${mm}` };
}

// state = { bot_enabled, schedule_enabled, timezone, windows: [{weekday, start, end}] }
// start/end son 'HH:MM' zero-padded → la comparación lexicográfica == cronológica.
function isBotActive(state, now = new Date()) {
  if (!state) return true;            // sin estado conocido → no bloquear
  if (!state.bot_enabled) return false;       // apagado manual
  if (!state.schedule_enabled) return true;   // 24/7
  let nowTz;
  try {
    nowTz = nowInTz(state.timezone, now);
  } catch {
    return true; // timezone inválida → fail-open (no bloquear el bot)
  }
  const { weekday, hhmm } = nowTz;
  return (state.windows || []).some((w) => {
    // end '00:00' = fin de día (medianoche) → comparar como '24:00'. Intervalo
    // semiabierto [start, end): hhmm (00:00–23:59) siempre < '24:00' → cubre hasta medianoche.
    const end = w.end === '00:00' ? '24:00' : w.end;
    return Number(w.weekday) === weekday && w.start <= hhmm && hhmm < end;
  });
}

module.exports = { isBotActive, nowInTz };
