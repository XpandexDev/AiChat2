const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// override:true es crítico — Hostinger/Passenger inyecta env vars cacheadas que
// no se borran al cambiarlas en hPanel. Sin override, el .env queda ignorado.
let envPath = path.resolve(__dirname, '.env');
let dotenvResult = dotenv.config({ path: envPath, override: true });
if (dotenvResult.error) {
  const fallback = path.resolve(__dirname, '..', '.env');
  const retry = dotenv.config({ path: fallback, override: true });
  if (!retry.error) {
    dotenvResult = retry;
    envPath = fallback;
  }
}

const requiredVars = [
  'PORT',
  'CORS_ORIGIN',
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  'SESSION_SECRET',
];

const optionalVars = [
  'WEBHOOK_INCOMING_URL',
  'WEBHOOK_SECRET',
  'AUTH_DATA_PATH',
  'HANDOFF_TTL_MINUTES',
];

// Loguea explícitamente para que Hostinger lo capture en console.log
console.log(`Node version: ${process.version}`);
console.log(`process.cwd(): ${process.cwd()}`);
console.log(`__dirname: ${__dirname}`);

const missing = requiredVars.filter((v) => !process.env[v]);
if (missing.length > 0) {
  console.error('==========================================');
  console.error('STARTUP FAILED: faltan env vars requeridas');
  console.error('Faltan:', missing.join(', '));
  console.error('Presentes:', requiredVars.filter((v) => process.env[v]).join(', ') || '(ninguna)');
  console.error('==========================================');
  process.exit(1);
}

console.log('Env vars requeridas: OK');

// --- Resolución del directorio de credenciales Baileys (CRÍTICO) ---
// Las credenciales de WhatsApp viven aquí. Si la ruta cambia entre arranques
// (p.ej. por ser relativa a un process.cwd() distinto) Baileys no las encuentra
// y TODOS los clientes tienen que re-escanear el QR. Por eso:
//   1. La normalizamos SIEMPRE a una ruta absoluta y determinista.
//   2. Las rutas relativas se anclan a la raíz del backend (no a process.cwd(),
//      que aaPanel/Passenger pueden cambiar entre versiones).
//   3. Avisamos a gritos si la ruta cae dentro de un repo git: un `git clean -fd`
//      o un track accidental borraría todas las sesiones en el próximo deploy.
function resolveAuthDataPath() {
  const raw = process.env.AUTH_DATA_PATH || '';
  // Ancla estable para rutas relativas: la carpeta que contiene src/ (backend
  // en dev, APP_DIR en deploy), nunca process.cwd().
  const anchor = path.resolve(__dirname, '..');
  const resolved = raw
    ? path.resolve(anchor, raw)
    : path.resolve(anchor, '.baileys_auth');
  return resolved;
}

function isInsideGitRepo(dir) {
  let current = dir;
  for (let i = 0; i < 30; i += 1) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

const AUTH_DATA_PATH = resolveAuthDataPath();
console.log(`AUTH_DATA_PATH (absoluto): ${AUTH_DATA_PATH}`);
if (!process.env.AUTH_DATA_PATH) {
  console.warn('AVISO: AUTH_DATA_PATH no está definido en el entorno; usando default. '
    + 'En producción defínelo a una ruta absoluta FUERA del directorio de deploy.');
}
const gitRoot = isInsideGitRepo(AUTH_DATA_PATH);
if (gitRoot) {
  console.warn('==========================================');
  console.warn('AVISO CRÍTICO: AUTH_DATA_PATH está dentro de un repo git:');
  console.warn(`  auth: ${AUTH_DATA_PATH}`);
  console.warn(`  repo: ${gitRoot}`);
  console.warn('Un "git clean -fd" o un track accidental BORRARÍA todas las');
  console.warn('sesiones de WhatsApp en el próximo deploy. Muévelo fuera del repo.');
  console.warn('==========================================');
}

module.exports = {
  PORT: Number(process.env.PORT || 3000),
  CORS_ORIGINS: (process.env.CORS_ORIGIN || 'http://localhost:4200,http://127.0.0.1:4200')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  DB_HOST: process.env.DB_HOST,
  DB_PORT: Number(process.env.DB_PORT),
  DB_USER: process.env.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD,
  DB_NAME: process.env.DB_NAME,
  SESSION_SECRET: process.env.SESSION_SECRET,
  WEBHOOK_INCOMING_URL: process.env.WEBHOOK_INCOMING_URL || '',
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || '',
  AUTH_DATA_PATH,
  // Minutos hasta que un handoff expira solo (rearme perezoso). Vacío/0 = sin
  // expiración: el bot solo vuelve cuando un humano pulsa "Devolver al bot".
  HANDOFF_TTL_MINUTES: process.env.HANDOFF_TTL_MINUTES ? Number(process.env.HANDOFF_TTL_MINUTES) : null,
};
