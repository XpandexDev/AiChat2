const pool = require('../../db/pool');

// Datos que el cliente gestiona de SÍ MISMO desde su panel. Todas las funciones
// reciben clientId resuelto por requireClient (nunca por parámetro de URL).

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// end '00:00' representa el fin del día (medianoche). Para comparar cronológicamente
// lo tratamos como '24:00' (mayor que cualquier hora válida de inicio).
const endForCompare = (e) => (e === '00:00' ? '24:00' : e);

function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    // Lanza RangeError si la timezone IANA no existe.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Valida y normaliza las franjas. Lanza Error code VALIDATION si algo falla.
function validateWindows(windows) {
  if (!Array.isArray(windows)) {
    const e = new Error('windows debe ser un array'); e.code = 'VALIDATION'; throw e;
  }
  const clean = windows.map((w) => ({
    weekday: Number(w?.weekday),
    start: String(w?.start || ''),
    end: String(w?.end || ''),
  }));
  for (const w of clean) {
    if (!Number.isInteger(w.weekday) || w.weekday < 0 || w.weekday > 6) {
      const e = new Error('weekday fuera de rango (0-6)'); e.code = 'VALIDATION'; throw e;
    }
    if (!TIME_RE.test(w.start) || !TIME_RE.test(w.end)) {
      const e = new Error('Formato de hora inválido (HH:MM)'); e.code = 'VALIDATION'; throw e;
    }
    if (w.start >= endForCompare(w.end)) {
      const e = new Error('La hora de inicio debe ser anterior a la de fin (usa 00:00 como fin para medianoche)'); e.code = 'VALIDATION'; throw e;
    }
  }
  // Sin solapes dentro del mismo día.
  const byDay = new Map();
  for (const w of clean) {
    if (!byDay.has(w.weekday)) byDay.set(w.weekday, []);
    byDay.get(w.weekday).push(w);
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 1; i < list.length; i += 1) {
      if (list[i].start < endForCompare(list[i - 1].end)) {
        const e = new Error('Las franjas de un mismo día no pueden solaparse'); e.code = 'VALIDATION'; throw e;
      }
    }
  }
  return clean;
}

async function getSchedule(clientId) {
  const [rows] = await pool.execute(
    `SELECT weekday,
            TIME_FORMAT(start_time, '%H:%i') AS start,
            TIME_FORMAT(end_time, '%H:%i') AS end
     FROM client_schedule WHERE client_id = ?
     ORDER BY weekday, start_time`,
    [clientId],
  );
  return rows.map((r) => ({ weekday: r.weekday, start: r.start, end: r.end }));
}

async function getScheduleSettings(clientId) {
  const [rows] = await pool.execute(
    'SELECT schedule_enabled, timezone, auto_reply_text FROM clients WHERE id = ?',
    [clientId],
  );
  const c = rows[0] || {};
  return {
    scheduleEnabled: Boolean(c.schedule_enabled),
    timezone: c.timezone || 'Europe/Madrid',
    autoReplyText: c.auto_reply_text || '',
    windows: await getSchedule(clientId),
  };
}

async function replaceSchedule(clientId, { scheduleEnabled, timezone, autoReplyText, windows }) {
  const tz = String(timezone || 'Europe/Madrid');
  if (!isValidTimezone(tz)) {
    const e = new Error('Zona horaria inválida'); e.code = 'VALIDATION'; throw e;
  }
  const clean = validateWindows(windows || []);
  const text = autoReplyText != null ? String(autoReplyText) : null;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      'UPDATE clients SET schedule_enabled = ?, timezone = ?, auto_reply_text = ? WHERE id = ?',
      [scheduleEnabled ? 1 : 0, tz, text, clientId],
    );
    await conn.execute('DELETE FROM client_schedule WHERE client_id = ?', [clientId]);
    for (const w of clean) {
      await conn.execute(
        'INSERT INTO client_schedule (client_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)',
        [clientId, w.weekday, `${w.start}:00`, `${w.end}:00`],
      );
    }
    await conn.commit();
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
  return getScheduleSettings(clientId);
}

async function setBotEnabled(clientId, enabled) {
  await pool.execute('UPDATE clients SET bot_enabled = ? WHERE id = ?', [enabled ? 1 : 0, clientId]);
}

module.exports = { getSchedule, getScheduleSettings, replaceSchedule, setBotEnabled };
