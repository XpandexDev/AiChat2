const express = require('express');
const clientAuthService = require('./service');
const { requireClient, CLIENT_COOKIE_NAME } = require('../../middleware/client-auth');
const { clientLoginLimiter } = require('../../middleware/rate-limit');
const { auditLog } = require('../../middleware/audit');

const router = express.Router();

function cookieOptions(extra = {}) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    ...extra,
  };
}

router.post('/login', clientLoginLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña requeridos' });
  }

  try {
    const { rawToken, clientId, expiresAt: exp } = await clientAuthService.login(email, password, req);
    res.cookie(CLIENT_COOKIE_NAME, rawToken, cookieOptions({ expires: exp }));
    const client = await clientAuthService.getClientProfile(clientId);
    auditLog(null, 'panel.login', 'client', String(clientId), {}, req).catch(() => {});
    return res.json({ ok: true, client });
  } catch (error) {
    if (error.code === 'INVALID_CREDENTIALS') {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    return res.status(500).json({ error: error.message });
  }
});

router.get('/me', requireClient, async (req, res) => {
  try {
    const client = await clientAuthService.getClientProfile(req.clientId);
    if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
    return res.json(client);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/logout', requireClient, async (req, res) => {
  const rawToken = req.cookies?.[CLIENT_COOKIE_NAME];
  try {
    await clientAuthService.destroySession(rawToken);
  } catch (error) {
    console.error('Error destruyendo sesión de cliente:', error.message);
  }
  res.clearCookie(CLIENT_COOKIE_NAME, { path: '/' });
  auditLog(null, 'panel.logout', 'client', String(req.clientId), {}, req).catch(() => {});
  return res.json({ ok: true });
});

module.exports = router;
