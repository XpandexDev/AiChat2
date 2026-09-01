const rateLimit = require('express-rate-limit');

// 5/15min en producción (defensivo), 50/15min en dev para no chocar
// mientras se prueba. Override explícito vía LOGIN_RATE_MAX.
const isProd = process.env.NODE_ENV === 'production';
const MAX_ATTEMPTS = Number(process.env.LOGIN_RATE_MAX) || (isProd ? 5 : 50);

// Factory: cada instancia tiene su PROPIO MemoryStore. Así el login de admin y el
// de cliente NO comparten el contador por IP (agotar intentos en uno no bloquea el otro).
function makeLoginLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: MAX_ATTEMPTS,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator(req) {
      return req.ip || req.socket?.remoteAddress || 'unknown';
    },
    handler(_req, res) {
      res.status(429).json({
        error: 'Demasiados intentos de login. Inténtalo en unos minutos.',
      });
    },
  });
}

const loginLimiter = makeLoginLimiter();        // admin
const clientLoginLimiter = makeLoginLimiter();  // panel cliente (contador independiente)

// API pública v1: límite por API KEY (no por IP — varias integraciones pueden
// compartir IP y una key no debe agotar a otra). 120 req/min por defecto.
const API_RATE_MAX = Number(process.env.API_RATE_MAX) || 120;

function makeApiLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: API_RATE_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator(req) {
      return req.apiKeyHash || req.ip || 'unknown';
    },
    handler(_req, res) {
      res.set('Retry-After', '60');
      res.status(429).json({
        error: { code: 'rate_limited', message: 'Límite de peticiones alcanzado. Reintenta en un minuto.' },
      });
    },
  });
}

module.exports = { loginLimiter, clientLoginLimiter, makeLoginLimiter, makeApiLimiter };
