const bcrypt = require('bcryptjs');
const pool = require('../../db/pool');
const { generateRawToken, hashToken, expiresAt } = require('../../lib/session-tokens');

// Auth del panel de cliente. Espejo de modules/auth/service.js pero contra
// `clients` + `client_sessions`. La contraseña la asigna el admin (password_hash
// en clients); clientes inactivos (is_active=0) no pueden entrar.

const DUMMY_HASH = '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid';

async function findClientByEmail(email) {
  const [rows] = await pool.execute(
    'SELECT id, email, password_hash FROM clients WHERE email = ? AND is_active = 1',
    [email],
  );
  return rows[0] || null;
}

async function login(email, password, req) {
  const client = await findClientByEmail(email);
  // Tiempo ~constante: compara contra dummy si el cliente no existe o no tiene
  // contraseña asignada (anti enumeración / timing).
  const hashToCheck = client?.password_hash || DUMMY_HASH;
  const ok = await bcrypt.compare(password, hashToCheck);
  if (!client || !client.password_hash || !ok) {
    const error = new Error('Invalid email or password');
    error.code = 'INVALID_CREDENTIALS';
    throw error;
  }

  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const exp = expiresAt();
  const ua = req?.header?.('user-agent')?.slice(0, 500) || null;
  const ip = (req?.ip || req?.socket?.remoteAddress || '').slice(0, 45) || null;

  await pool.execute(
    'INSERT INTO client_sessions (token_hash, client_id, user_agent, ip_address, expires_at) VALUES (?, ?, ?, ?, ?)',
    [tokenHash, client.id, ua, ip, exp],
  );

  return { rawToken, clientId: client.id, expiresAt: exp };
}

async function validateSession(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const tokenHash = hashToken(rawToken);
  const [rows] = await pool.execute(
    'SELECT client_id, expires_at FROM client_sessions WHERE token_hash = ?',
    [tokenHash],
  );
  if (rows.length === 0) return null;
  const session = rows[0];
  if (new Date(session.expires_at) <= new Date()) {
    pool.execute('DELETE FROM client_sessions WHERE token_hash = ?', [tokenHash]).catch(() => {});
    return null;
  }
  return { clientId: session.client_id };
}

async function destroySession(rawToken) {
  if (!rawToken) return;
  const tokenHash = hashToken(rawToken);
  await pool.execute('DELETE FROM client_sessions WHERE token_hash = ?', [tokenHash]);
}

// Perfil seguro para /api/client/auth/me (identidad mínima).
async function getClientProfile(clientId) {
  const [rows] = await pool.execute(
    'SELECT id, name, email FROM clients WHERE id = ? AND is_active = 1',
    [clientId],
  );
  return rows[0] || null;
}

async function cleanupExpiredSessions() {
  try {
    const [result] = await pool.execute('DELETE FROM client_sessions WHERE expires_at < NOW()');
    if (result.affectedRows > 0) {
      console.log(`Cleaned up ${result.affectedRows} expired client sessions`);
    }
  } catch (error) {
    console.error('Error cleaning expired client sessions:', error.message);
  }
}

module.exports = {
  login,
  validateSession,
  destroySession,
  getClientProfile,
  cleanupExpiredSessions,
};
