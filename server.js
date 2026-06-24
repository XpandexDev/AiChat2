const path = require('path');
const fsSync = require('fs');
const http = require('http');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

const config = require('./config');
const { runMigrations } = require('./db/migrate');
const { bootstrapFirstAdmin } = require('./db/bootstrap');
const authService = require('./modules/auth/service');
const clientAuthService = require('./modules/client-auth/service');

const authRoutes = require('./modules/auth/routes');
const auditRoutes = require('./modules/audit/routes');
const clientsRoutes = require('./modules/clients/routes');
const sessionsRoutes = require('./modules/sessions/routes');
const messagesRoutes = require('./modules/sessions/messages-routes');
const sessionsManager = require('./modules/sessions/manager');
const webhookRoutes = require('./modules/webhooks/routes');
const pairingRoutes = require('./modules/pairing/routes');
const clientAuthRoutes = require('./modules/client-auth/routes');
const clientPanelRoutes = require('./modules/client-panel/routes');

console.log('Iniciando app Node...');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, methods: ['GET', 'POST'] },
});

app.set('trust proxy', 1);

const corsOptions = {
  origin(origin, callback) {
    if (!origin || config.CORS_ORIGINS.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`Origen no permitido por CORS: ${origin}`));
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

console.log(`Config: PORT=${config.PORT} CORS_ORIGINS=${config.CORS_ORIGINS.join(',')} AUTH=${config.AUTH_DATA_PATH}`);
console.log('Express configurado');

// --- Public health ---
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

// --- API routes (admin-only salvo webhookPublicRouter) ---
app.use('/api/admin/auth', authRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/clients', clientsRoutes);
app.use('/api/sessions', sessionsRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/pairing', pairingRoutes);
// Panel self-service por cliente. El específico (/api/client/auth) ANTES del
// genérico (/api/client), y ambos antes del catch-all del SPA.
app.use('/api/client/auth', clientAuthRoutes);
app.use('/api/client', clientPanelRoutes);

sessionsManager.init(io);

const staticPath = path.resolve(process.cwd(), 'deploy', 'browser');
if (fsSync.existsSync(staticPath)) {
  console.log(`Sirviendo archivos estáticos desde: ${staticPath}`);
  app.use(express.static(staticPath));
  app.get('/*splat', (_req, res) => {
    res.sendFile(path.join(staticPath, 'index.html'));
  });
} else {
  console.log(`No se sirve frontend estático (no existe ${staticPath})`);
}

server.on('error', (error) => console.error('Error en el servidor HTTP:', error));

process.on('exit', (code) => console.error(`Proceso saliendo con código ${code}`));
process.on('SIGINT', () => { console.error('Recibido SIGINT'); process.exit(0); });
process.on('SIGTERM', () => { console.error('Recibido SIGTERM'); process.exit(0); });
process.on('uncaughtException', (error) => console.error('uncaughtException:', error));
process.on('unhandledRejection', (reason) => console.error('unhandledRejection:', reason));

// Tras un reboot del VPS, MySQL puede tardar en aceptar conexiones. Si
// abortáramos al primer fallo (process.exit), aaPanel reiniciaría en bucle y
// NINGUNA sesión de WhatsApp reconectaría hasta que la BD respondiese. En su
// lugar reintentamos con backoff durante varios minutos; solo si la BD nunca
// vuelve salimos para que el supervisor reinicie de forma limpia.
async function initDbWithRetry() {
  const maxAttempts = 30;          // ~10 min con el backoff de abajo
  const baseDelayMs = 2000;
  const capMs = 30000;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      console.log(`Running database migrations... (intento ${attempt}/${maxAttempts})`);
      await runMigrations();
      await bootstrapFirstAdmin();
      await authService.cleanupExpiredSessions();
      await clientAuthService.cleanupExpiredSessions();
      return;
    } catch (error) {
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), capMs);
      console.error(`Startup DB step failed (intento ${attempt}): ${error.message}`);
      if (attempt === maxAttempts) {
        console.error('BD no disponible tras todos los reintentos. Saliendo para reinicio limpio.');
        process.exit(1);
      }
      console.error(`Reintentando en ${Math.round(delay / 1000)}s…`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function startServer() {
  await initDbWithRetry();

  // Re-arranca sesiones WA que estaban vivas antes del último restart.
  // No bloquea el listen: cada reconexión va en su propia promise.
  sessionsManager.resumeSessions().catch((err) => {
    console.error('resumeSessions error:', err.message);
  });

  server.listen(config.PORT, () => {
    console.log(`Backend listo en puerto ${config.PORT}`);
  });
}

startServer();

module.exports = app;
