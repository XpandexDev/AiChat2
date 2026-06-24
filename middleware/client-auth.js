const clientAuthService = require('../modules/client-auth/service');

// Cookie DISTINTA de la del admin ('session') para que admin y cliente puedan
// estar logueados a la vez en el mismo navegador sin pisarse.
const CLIENT_COOKIE_NAME = 'client_session';

async function requireClient(req, res, next) {
  const rawToken = req.cookies?.[CLIENT_COOKIE_NAME];
  if (!rawToken) {
    return res.status(401).json({ error: 'No autenticado' });
  }
  try {
    const session = await clientAuthService.validateSession(rawToken);
    if (!session) {
      res.clearCookie(CLIENT_COOKIE_NAME, { path: '/' });
      return res.status(401).json({ error: 'Sesión inválida o expirada' });
    }
    req.clientId = session.clientId;
    next();
  } catch (error) {
    return res.status(500).json({ error: `Error validando sesión: ${error.message}` });
  }
}

module.exports = { requireClient, CLIENT_COOKIE_NAME };
