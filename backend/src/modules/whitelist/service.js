const pool = require('../../db/pool');

// Whitelist por contacto, ACTIVABLE por cliente. Cuando `whitelist_enabled`
// está a 1, el bot solo atiende a los números de la lista (modo pruebas o bots
// restringidos); a 0 se ignora por completo. La blacklist tiene prioridad.
// Los `contactJid` llegan YA normalizados (el caller usa manager.normalizeJid)
// para evitar un require cíclico con el manager.

async function isEnabled(clientId) {
  if (!clientId) return false;
  const [rows] = await pool.execute(
    'SELECT whitelist_enabled FROM clients WHERE id = ?',
    [clientId],
  );
  return Boolean(rows[0]?.whitelist_enabled);
}

async function isWhitelisted(clientId, contactJid) {
  if (!clientId || !contactJid) return false;
  const [rows] = await pool.execute(
    'SELECT 1 FROM client_whitelist WHERE client_id = ? AND contact_jid = ? LIMIT 1',
    [clientId, contactJid],
  );
  return rows.length > 0;
}

/**
 * ¿Debe el bot IGNORAR a este contacto por la whitelist?
 * true solo si la lista está activada y el contacto NO está en ella.
 * Una sola consulta con JOIN para no encadenar dos queries por mensaje.
 */
async function isBlockedByWhitelist(clientId, contactJid) {
  if (!clientId || !contactJid) return false;
  const [rows] = await pool.execute(
    `SELECT c.whitelist_enabled AS enabled,
            (SELECT 1 FROM client_whitelist w
              WHERE w.client_id = c.id AND w.contact_jid = ? LIMIT 1) AS allowed
     FROM clients c WHERE c.id = ?`,
    [contactJid, clientId],
  );
  const row = rows[0];
  if (!row || !row.whitelist_enabled) return false;
  return !row.allowed;
}

async function list(clientId) {
  const [rows] = await pool.execute(
    `SELECT contact_jid AS contactJid, note, created_at AS createdAt
     FROM client_whitelist WHERE client_id = ? ORDER BY created_at DESC`,
    [clientId],
  );
  return rows;
}

async function getState(clientId) {
  return { enabled: await isEnabled(clientId), entries: await list(clientId) };
}

async function setEnabled(clientId, enabled) {
  await pool.execute(
    'UPDATE clients SET whitelist_enabled = ? WHERE id = ?',
    [enabled ? 1 : 0, clientId],
  );
  return getState(clientId);
}

async function add(clientId, contactJid, note) {
  if (!contactJid) {
    const e = new Error('Número inválido'); e.code = 'VALIDATION'; throw e;
  }
  const cleanNote = note != null ? String(note).trim().slice(0, 255) || null : null;
  await pool.execute(
    `INSERT INTO client_whitelist (client_id, contact_jid, note) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE note = VALUES(note)`,
    [clientId, contactJid, cleanNote],
  );
  return getState(clientId);
}

async function remove(clientId, contactJid) {
  if (!contactJid) return getState(clientId);
  await pool.execute(
    'DELETE FROM client_whitelist WHERE client_id = ? AND contact_jid = ?',
    [clientId, contactJid],
  );
  return getState(clientId);
}

module.exports = {
  isEnabled, isWhitelisted, isBlockedByWhitelist, list, getState, setEnabled, add, remove,
};
