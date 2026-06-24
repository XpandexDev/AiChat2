const pool = require('../../db/pool');

// Blacklist por contacto: el bot ignora por completo a estos números (silencio
// total). Los `contactJid` llegan YA normalizados (el caller usa
// manager.normalizeJid) para evitar un require cíclico con el manager.

async function isBlacklisted(clientId, contactJid) {
  if (!clientId || !contactJid) return false;
  const [rows] = await pool.execute(
    'SELECT 1 FROM client_blacklist WHERE client_id = ? AND contact_jid = ? LIMIT 1',
    [clientId, contactJid],
  );
  return rows.length > 0;
}

async function list(clientId) {
  const [rows] = await pool.execute(
    `SELECT contact_jid AS contactJid, note, created_at AS createdAt
     FROM client_blacklist WHERE client_id = ? ORDER BY created_at DESC`,
    [clientId],
  );
  return rows;
}

async function add(clientId, contactJid, note) {
  if (!contactJid) {
    const e = new Error('Número inválido'); e.code = 'VALIDATION'; throw e;
  }
  const cleanNote = note != null ? String(note).trim().slice(0, 255) || null : null;
  await pool.execute(
    `INSERT INTO client_blacklist (client_id, contact_jid, note) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE note = VALUES(note)`,
    [clientId, contactJid, cleanNote],
  );
  return list(clientId);
}

async function remove(clientId, contactJid) {
  if (!contactJid) return list(clientId);
  await pool.execute(
    'DELETE FROM client_blacklist WHERE client_id = ? AND contact_jid = ?',
    [clientId, contactJid],
  );
  return list(clientId);
}

module.exports = { isBlacklisted, list, add, remove };
