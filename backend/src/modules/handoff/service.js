const pool = require('../../db/pool');

// Estado de handoff "humano al mando" por (cliente, contacto). Fuente de verdad
// en MariaDB (no memoria): la app puede correr multi-worker y un reinicio no debe
// dejar contactos atascados. El lookup por mensaje (isPaused) usa el índice único
// (client_id, contact_jid) → point-lookup barato.

// ¿El contacto está en modo humano (y no expirado)? Una llamada por mensaje entrante.
async function isPaused(clientId, contactJid) {
  if (!clientId || !contactJid) return false;
  const [rows] = await pool.execute(
    `SELECT 1 FROM handoff_state
     WHERE client_id = ? AND contact_jid = ? AND status = 'human'
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1`,
    [clientId, contactJid],
  );
  return rows.length > 0;
}

// Marca el contacto en modo humano. UPSERT: reactiva una fila previa sin duplicar.
// ttlMinutes opcional → expira solo (rearme perezoso); null = solo rearme manual.
async function start(clientId, contactJid, opts = {}) {
  if (!clientId || !contactJid) return;
  const { motivo = null, resumen = null, sessionId = null, ttlMinutes = null } = opts;
  const expiresAt = ttlMinutes ? new Date(Date.now() + ttlMinutes * 60000) : null;
  await pool.execute(
    `INSERT INTO handoff_state
       (client_id, contact_jid, session_id, status, motivo, resumen, assigned_at, released_at, expires_at)
     VALUES (?, ?, ?, 'human', ?, ?, NOW(), NULL, ?)
     ON DUPLICATE KEY UPDATE
       status = 'human', session_id = VALUES(session_id), motivo = VALUES(motivo),
       resumen = VALUES(resumen), assigned_at = NOW(), released_at = NULL,
       expires_at = VALUES(expires_at)`,
    [clientId, contactJid, sessionId, motivo, resumen, expiresAt],
  );
}

// Devuelve el control al bot. No borra la fila (historial): status='bot'.
async function resume(clientId, contactJid) {
  if (!clientId || !contactJid) return false;
  const [res] = await pool.execute(
    `UPDATE handoff_state SET status = 'bot', released_at = NOW()
     WHERE client_id = ? AND contact_jid = ? AND status = 'human'`,
    [clientId, contactJid],
  );
  return res.affectedRows > 0;
}

// Contactos vigentes en modo humano, para hidratar el panel al cargar.
async function listActive(clientId = null) {
  const filterClient = clientId ? 'AND client_id = ?' : '';
  const params = clientId ? [clientId] : [];
  const [rows] = await pool.execute(
    `SELECT client_id AS clientId, contact_jid AS contactJid, session_id AS sessionId,
            motivo, resumen, assigned_at AS assignedAt, expires_at AS expiresAt
     FROM handoff_state
     WHERE status = 'human' AND (expires_at IS NULL OR expires_at > NOW()) ${filterClient}
     ORDER BY assigned_at DESC`,
    params,
  );
  return rows;
}

module.exports = { isPaused, start, resume, listActive };
