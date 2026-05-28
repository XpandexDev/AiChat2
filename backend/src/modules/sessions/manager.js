const path = require('path');
const fs = require('fs/promises');
const QRCode = require('qrcode');
const pino = require('pino');
const config = require('../../config');
const pool = require('../../db/pool');
const webhooks = require('../webhooks/service');

const baileysPromise = import('@whiskeysockets/baileys');
const baileysLogger = pino({ level: 'silent' });

// Runtime state — Map keyed por session_id (globalmente único).
// Cada entrada lleva el clientId para resolver webhook config.
const sessions = new Map();
let io = null;

function init(socketIo) {
  io = socketIo;
  io.on('connection', (socket) => {
    socket.emit('sessions:init', listSessions());
  });
}

function serializeSession(session) {
  return {
    sessionId: session.sessionId,
    clientId: session.clientId,
    mode: session.mode,
    status: session.status,
    qrDataUrl: session.qrDataUrl,
    lastError: session.lastError,
    connectedNumber: session.connectedNumber,
    updatedAt: session.updatedAt,
  };
}

function emitSessionUpdate(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || !io) return;
  io.emit('session:update', serializeSession(session));
}

function updateSession(sessionId, patch) {
  const session = sessions.get(sessionId);
  if (!session) return;
  Object.assign(session, patch, { updatedAt: new Date().toISOString() });
  emitSessionUpdate(sessionId);
  persistStatus(session).catch((err) => console.error('persistStatus error:', err.message));
}

async function persistStatus(session) {
  // Reflejar el último estado en BD (best effort, no bloquea).
  try {
    await pool.execute(
      `UPDATE wa_sessions
       SET status = ?, phone_number = ?, last_error = ?
       WHERE session_id = ?`,
      [session.status, session.connectedNumber, session.lastError, session.sessionId],
    );
  } catch (error) {
    // No tirar la app si la BD está fuera momentáneamente
    console.error('Error persistiendo estado de sesión:', error.message);
  }
}

function normalizeJid(input) {
  if (input === null || input === undefined) return null;
  const str = String(input).trim();
  if (!str) return null;
  if (str.includes('@')) {
    if (str.endsWith('@c.us')) return str.replace('@c.us', '@s.whatsapp.net');
    return str;
  }
  const digits = str.replace(/\D/g, '');
  if (!digits) return null;
  return `${digits}@s.whatsapp.net`;
}

function extractText(message) {
  if (!message) return '';
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.documentMessage?.caption) return message.documentMessage.caption;
  if (message.buttonsResponseMessage?.selectedDisplayText) {
    return message.buttonsResponseMessage.selectedDisplayText;
  }
  if (message.listResponseMessage?.title) return message.listResponseMessage.title;
  return '';
}

function hasMedia(message) {
  if (!message) return false;
  return Boolean(
    message.imageMessage
      || message.videoMessage
      || message.documentMessage
      || message.audioMessage
      || message.stickerMessage,
  );
}

function messageType(message) {
  if (!message) return 'unknown';
  return Object.keys(message)[0] || 'unknown';
}

// --- Reconexión con backoff (C4+C5) ---
// Reconectar a intervalo fijo bombardea a WhatsApp y arriesga un bloqueo del
// número. Usamos backoff exponencial con jitter, sin rendirnos nunca para los
// fallos transitorios (red, timeout, restartRequired) — el objetivo es que una
// sesión vinculada jamás se quede caída sola.
const RECONNECT_BASE_MS = 2000;
const RECONNECT_CAP_MS = 60000;
// 'loggedOut' lo emite Baileys también por desconexiones espurias. Reintentamos
// un número limitado de veces (sin borrar creds) para recuperar esos casos; si
// de verdad está deslogueada, se agotan y queda en auth_failure para que el
// admin/cliente decida.
const MAX_LOGGED_OUT_RETRIES = 5;
const LOGGED_OUT_BASE_MS = 15000;

function computeBackoff(attempt, baseMs, capMs) {
  const exp = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), capMs);
  const jitter = Math.random() * 0.3 * exp; // hasta +30% para desincronizar reintentos
  return Math.round(exp + jitter);
}

function clearReconnectTimer(session) {
  if (session && session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
}

function scheduleReconnect(session, { reasonName, baseMs, capMs, attemptKey }) {
  const current = sessions.get(session.sessionId);
  if (!current || current.status === 'stopped') return;

  session[attemptKey] = (session[attemptKey] || 0) + 1;
  const delay = computeBackoff(session[attemptKey], baseMs, capMs);

  updateSession(session.sessionId, {
    status: 'disconnected',
    connectedNumber: null,
    lastError: `Desconectado (${reasonName}). Reintento ${session[attemptKey]} en ${Math.round(delay / 1000)}s…`,
  });

  clearReconnectTimer(session);
  session.reconnectTimer = setTimeout(() => {
    const cur = sessions.get(session.sessionId);
    if (!cur || cur.status === 'stopped') return; // parada mientras esperábamos
    connectSocket(session).catch((err) => {
      // El fallo al reconectar tampoco es terminal: reprogramamos con el mismo
      // contador para que el backoff siga creciendo.
      scheduleReconnect(session, { reasonName: `error: ${err.message}`, baseMs, capMs, attemptKey });
    });
  }, delay);
}

async function connectSocket(session) {
  const baileys = await baileysPromise;
  // En distintas versiones Baileys exporta makeWASocket de formas distintas:
  //  - 6.7.x: baileys.default (función)
  //  - 6.17.x: baileys.makeWASocket (named), baileys.default es un objeto
  //  - >=7: pendiente confirmar
  // Cogemos la primera que SEA función.
  const makeWASocket = [baileys.makeWASocket, baileys.default?.default, baileys.default]
    .find((x) => typeof x === 'function');
  if (typeof makeWASocket !== 'function') {
    throw new Error('Baileys: makeWASocket no encontrado en este build (' + Object.keys(baileys).slice(0,5).join(',') + '...)');
  }
  const { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = baileys;

  const authDir = path.join(config.AUTH_DATA_PATH, `session-${session.sessionId}`);
  await fs.mkdir(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    // Si no podemos consultar la versión usamos la default de baileys
  }

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['Chatbot', 'Chrome', '120'],
    logger: baileysLogger,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  session.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr);
        updateSession(session.sessionId, {
          status: 'waiting_qr_scan',
          qrDataUrl,
          lastError: null,
        });
      } catch (error) {
        updateSession(session.sessionId, {
          status: 'error',
          lastError: `No se pudo generar QR: ${error.message}`,
        });
      }
    }

    if (connection === 'open') {
      const rawId = sock.user?.id || '';
      const connectedNumber = rawId.split(':')[0].split('@')[0] || null;
      // Conexión sana: reseteamos los contadores de backoff.
      session.reconnectAttempts = 0;
      session.loggedOutRetries = 0;
      clearReconnectTimer(session);
      updateSession(session.sessionId, {
        status: 'ready',
        qrDataUrl: null,
        connectedNumber,
        lastError: null,
      });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reasonName = Object.entries(DisconnectReason).find(([, v]) => v === statusCode)?.[0]
        || `status ${statusCode ?? 'desconocido'}`;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      const current = sessions.get(session.sessionId);
      const replaced = statusCode === DisconnectReason.connectionReplaced;

      if (replaced) {
        // Otro proceso (otro worker o WhatsApp Web en navegador) tomó la sesión.
        // NO reconectar — sería un ping-pong infinito que arruina los contadores
        // de Signal Protocol. Dejamos al otro proceso continuar.
        clearReconnectTimer(session);
        updateSession(session.sessionId, {
          status: 'stopped',
          connectedNumber: null,
          lastError: 'Otro proceso o navegador tomó la sesión (connectionReplaced). Si fue accidental, pulsa "Iniciar".',
        });
        session.sock = null;
      } else if (loggedOut) {
        // NO borramos los creds: Baileys reporta 'loggedOut' también por
        // desconexiones espurias. Reintentamos un número limitado de veces con
        // backoff largo para recuperar esos casos. Solo si se agotan dejamos la
        // sesión en auth_failure (probable deslogueo real).
        session.sock = null;
        if ((session.loggedOutRetries || 0) < MAX_LOGGED_OUT_RETRIES && current && current.status !== 'stopped') {
          scheduleReconnect(session, {
            reasonName: `${reasonName} (posible espurio)`,
            baseMs: LOGGED_OUT_BASE_MS,
            capMs: RECONNECT_CAP_MS,
            attemptKey: 'loggedOutRetries',
          });
        } else {
          clearReconnectTimer(session);
          updateSession(session.sessionId, {
            status: 'auth_failure',
            connectedNumber: null,
            qrDataUrl: null,
            lastError: `Sesión rechazada por WhatsApp (${reasonName}) tras varios reintentos. Pulsa "Iniciar" para reintentar o "Eliminar" para vincular un número nuevo.`,
          });
        }
      } else if (current && current.status !== 'stopped') {
        // Desconexión transitoria (red, timeout, restartRequired): reconexión
        // con backoff exponencial + jitter, sin rendirnos.
        session.sock = null;
        scheduleReconnect(session, {
          reasonName,
          baseMs: RECONNECT_BASE_MS,
          capMs: RECONNECT_CAP_MS,
          attemptKey: 'reconnectAttempts',
        });
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key?.fromMe) continue;

      const payload = {
        type: 'incoming_message',
        source: 'whatsapp-web',
        sessionId: session.sessionId,
        clientId: session.clientId,
        mode: session.mode,
        timestamp: new Date().toISOString(),
        message: {
          id: msg.key.id || null,
          from: msg.key.remoteJid,
          body: extractText(msg.message),
          type: messageType(msg.message),
          hasMedia: hasMedia(msg.message),
        },
      };

      if (io) io.emit('message:incoming', payload);

      try {
        const reply = await webhooks.forwardIncoming(session.clientId, payload, {
          connectedNumber: session.connectedNumber,
        });
        updateSession(session.sessionId, { lastError: null });
        if (reply && session.sock) {
          const jid = normalizeJid(reply.to);
          if (jid) {
            // Protocolo con n8n: \n = salto de línea dentro del mensaje,
            // \n\n = separador entre mensajes WhatsApp distintos.
            const parts = String(reply.text)
              .split(/\n{2,}/)
              .map((p) => p.trim())
              .filter(Boolean);
            const chunks = parts.length > 0 ? parts : [String(reply.text)];

            for (let i = 0; i < chunks.length; i++) {
              try {
                const sent = await session.sock.sendMessage(jid, { text: chunks[i] });
                if (io) {
                  io.emit('message:outgoing', {
                    type: 'outgoing_message',
                    source: 'webhook-response',
                    sessionId: session.sessionId,
                    clientId: session.clientId,
                    timestamp: new Date().toISOString(),
                    message: { id: sent?.key?.id || null, to: jid, body: chunks[i] },
                  });
                }
                if (i < chunks.length - 1) {
                  await new Promise((r) => setTimeout(r, 800));
                }
              } catch (sendErr) {
                console.error('Error enviando respuesta de webhook:', sendErr.message);
                break;
              }
            }
          }
        }
      } catch (error) {
        updateSession(session.sessionId, {
          lastError: `Error enviando webhook entrante: ${webhooks.formatError(error)}`,
        });
      }
    }
  });
}

async function startSession({ clientId, sessionId, mode = 'normal' }) {
  if (!clientId || !sessionId) {
    const e = new Error('clientId y sessionId son requeridos');
    e.code = 'VALIDATION';
    throw e;
  }

  // Verificar que el cliente existe y está activo
  const [[client]] = await pool.execute(
    'SELECT id, is_active FROM clients WHERE id = ?',
    [clientId],
  );
  if (!client) {
    const e = new Error(`Cliente ${clientId} no existe`);
    e.code = 'CLIENT_NOT_FOUND';
    throw e;
  }
  if (!client.is_active) {
    const e = new Error(`Cliente ${clientId} está inactivo`);
    e.code = 'CLIENT_INACTIVE';
    throw e;
  }

  // Si ya existe en memoria y no está parada, devolver el estado actual
  if (sessions.has(sessionId)) {
    const existing = sessions.get(sessionId);
    if (existing.clientId !== clientId) {
      const e = new Error(`session_id "${sessionId}" ya está en uso por otro cliente`);
      e.code = 'CONFLICT';
      throw e;
    }
    if (existing.status === 'stopped') {
      sessions.delete(sessionId);
    } else {
      return serializeSession(existing);
    }
  }

  // INSERT/UPDATE wa_sessions row. session_id es UNIQUE — si ya existe en BD,
  // verificamos que pertenezca al mismo cliente.
  const [existingRows] = await pool.execute(
    'SELECT client_id FROM wa_sessions WHERE session_id = ?',
    [sessionId],
  );
  if (existingRows.length > 0 && existingRows[0].client_id !== clientId) {
    const e = new Error(`session_id "${sessionId}" ya está en uso por otro cliente`);
    e.code = 'CONFLICT';
    throw e;
  }
  if (existingRows.length === 0) {
    await pool.execute(
      'INSERT INTO wa_sessions (client_id, session_id, status) VALUES (?, ?, ?)',
      [clientId, sessionId, 'starting'],
    );
  } else {
    await pool.execute(
      'UPDATE wa_sessions SET status = ?, last_error = NULL WHERE session_id = ?',
      ['starting', sessionId],
    );
  }

  const session = {
    sessionId,
    clientId,
    mode,
    status: 'starting',
    qrDataUrl: null,
    lastError: null,
    connectedNumber: null,
    updatedAt: new Date().toISOString(),
    sock: null,
  };

  sessions.set(sessionId, session);
  emitSessionUpdate(sessionId);

  try {
    await connectSocket(session);
  } catch (error) {
    updateSession(sessionId, { status: 'error', lastError: error.message });
  }

  return serializeSession(session);
}

async function stopSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    // Tal vez nunca se levantó en memoria pero existe en BD — actualizamos status.
    const [result] = await pool.execute(
      'UPDATE wa_sessions SET status = ? WHERE session_id = ?',
      ['stopped', sessionId],
    );
    return result.affectedRows > 0;
  }

  // Cancelar cualquier reintento pendiente para que no reviva la sesión parada.
  clearReconnectTimer(session);

  try {
    if (session.sock) session.sock.end(undefined);
  } catch (error) {
    updateSession(sessionId, { lastError: `Error al cerrar sesión: ${error.message}` });
  }

  updateSession(sessionId, {
    status: 'stopped',
    qrDataUrl: null,
    connectedNumber: null,
    sock: null,
  });

  return true;
}

async function deleteSession(sessionId) {
  const session = sessions.get(sessionId);

  if (session) clearReconnectTimer(session);
  if (session?.sock) {
    try { await session.sock.logout(); } catch { /* ignore */ }
    try { session.sock.end(undefined); } catch { /* ignore */ }
  }

  sessions.delete(sessionId);

  await pool.execute('DELETE FROM wa_sessions WHERE session_id = ?', [sessionId]);

  const authDir = path.join(config.AUTH_DATA_PATH, `session-${sessionId}`);
  let warning = null;
  try {
    await fs.rm(authDir, { recursive: true, force: true });
  } catch (error) {
    warning = `No se pudo borrar ${authDir}: ${error.message}`;
  }

  if (io) io.emit('session:removed', warning ? { sessionId, warning } : { sessionId });
  return warning ? { ok: true, warning } : { ok: true };
}

// Borrar TODAS las sesiones de un cliente (memoria + disco). Llamado desde
// clients/routes al borrar un cliente. La cascada DB se encarga del resto.
async function dropSessionsForClient(clientId) {
  const [rows] = await pool.execute(
    'SELECT session_id FROM wa_sessions WHERE client_id = ?',
    [clientId],
  );
  let count = 0;
  for (const { session_id: sid } of rows) {
    const session = sessions.get(sid);
    if (session) clearReconnectTimer(session);
    if (session?.sock) {
      try { await session.sock.logout(); } catch { /* ignore */ }
      try { session.sock.end(undefined); } catch { /* ignore */ }
    }
    sessions.delete(sid);
    const authDir = path.join(config.AUTH_DATA_PATH, `session-${sid}`);
    try { await fs.rm(authDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (io) io.emit('session:removed', { sessionId: sid });
    count += 1;
  }
  return count;
}

async function sendMessage(sessionId, to, text) {
  const session = sessions.get(sessionId);
  if (!session || !session.sock) {
    throw new Error(`La sesión ${sessionId} no existe o no está inicializada.`);
  }

  if (session.status !== 'ready') {
    throw new Error(`La sesión ${sessionId} no está lista. Estado: ${session.status}`);
  }

  const jid = normalizeJid(to);
  if (!jid) {
    throw new Error('Destino inválido. Usa número internacional, por ejemplo: 34600111222');
  }

  const sent = await session.sock.sendMessage(jid, { text: String(text) });

  const payload = {
    type: 'outgoing_message',
    source: 'chatbot',
    sessionId,
    clientId: session.clientId,
    timestamp: new Date().toISOString(),
    message: {
      id: sent?.key?.id || null,
      to: jid,
      body: text,
    },
  };

  if (io) io.emit('message:outgoing', payload);
  return payload;
}

function listSessions() {
  return [...sessions.values()].map(serializeSession);
}

// Lock file para evitar que VARIOS workers de Passenger reanuden las mismas
// sesiones (cada uno crearía su propio Baileys → connectionReplaced ping-pong
// + MessageCounterError de libsignal). Solo el worker que toma el lock corre
// resumeSessions; los demás lo dejan en paz.
function getResumerLockPath() {
  return path.join(config.AUTH_DATA_PATH, 'resumer.lock');
}

async function tryAcquireResumerLock() {
  const lockPath = getResumerLockPath();
  try {
    const existing = await fs.readFile(lockPath, 'utf-8');
    const pid = Number(existing.trim());
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);  // signal 0 = ¿está vivo?
        return false;          // otro worker activo tiene el lock
      } catch {
        // proceso muerto → lock stale, lo tomamos
      }
    }
  } catch { /* no existe → lo creamos */ }
  await fs.mkdir(config.AUTH_DATA_PATH, { recursive: true });
  await fs.writeFile(lockPath, String(process.pid));
  return true;
}

async function releaseResumerLock() {
  const lockPath = getResumerLockPath();
  try {
    const existing = await fs.readFile(lockPath, 'utf-8');
    if (Number(existing.trim()) === process.pid) {
      await fs.unlink(lockPath);
    }
  } catch { /* ignore */ }
}

process.on('exit', () => {
  // sync best-effort para liberar el lock cuando termina el worker
  try {
    const fsSync = require('fs');
    const lockPath = getResumerLockPath();
    if (fsSync.existsSync(lockPath)) {
      const pid = Number(fsSync.readFileSync(lockPath, 'utf-8').trim());
      if (pid === process.pid) fsSync.unlinkSync(lockPath);
    }
  } catch { /* ignore */ }
});

// Auto-resume sesiones que estaban activas antes del último restart de Passenger.
async function resumeSessions() {
  const gotLock = await tryAcquireResumerLock();
  if (!gotLock) {
    console.log('Another worker holds the resumer lock — skipping session resume');
    return;
  }
  try {
    // Incluimos auth_failure/error: tras un restart reintentamos también las que
    // cayeron por fallos espurios (un intento las recupera; si están deslogueadas
    // de verdad vuelven a auth_failure). Solo 'stopped' queda fuera: es voluntario.
    const [rows] = await pool.execute(
      `SELECT client_id, session_id FROM wa_sessions
       WHERE status IN ('ready', 'authenticated', 'starting', 'waiting_qr_scan', 'disconnected', 'auth_failure', 'error')
       ORDER BY updated_at DESC`,
    );
    if (rows.length === 0) {
      console.log('No sessions to resume');
      return;
    }
    console.log(`Resuming ${rows.length} WA session(s)… (worker pid ${process.pid})`);
    // Concurrencia limitada a 3 para no spamear a WhatsApp si hay muchas
    const queue = [...rows];
    const workers = Array.from({ length: 3 }, async () => {
      while (queue.length > 0) {
        const row = queue.shift();
        try {
          await startSession({ clientId: row.client_id, sessionId: row.session_id, mode: 'normal' });
        } catch (err) {
          console.error(`Resume failed for ${row.session_id}:`, err.message);
        }
      }
    });
    await Promise.allSettled(workers);
  } catch (err) {
    console.error('resumeSessions error:', err.message);
  }
}

async function listSessionsByClient(clientId) {
  // Combina BD (todas las que pertenecen al cliente) con runtime (estado vivo).
  const [rows] = await pool.execute(
    `SELECT session_id, status, phone_number, last_error, created_at, updated_at
     FROM wa_sessions WHERE client_id = ? ORDER BY id DESC`,
    [clientId],
  );
  return rows.map((row) => {
    const live = sessions.get(row.session_id);
    if (live) return serializeSession(live);
    return {
      sessionId: row.session_id,
      clientId,
      mode: null,
      status: row.status || 'stopped',
      qrDataUrl: null,
      lastError: row.last_error,
      connectedNumber: row.phone_number,
      updatedAt: row.updated_at,
    };
  });
}

function getSession(sessionId) {
  const s = sessions.get(sessionId);
  return s ? serializeSession(s) : null;
}

// Resuelve el clientId dueño de un session_id (vía BD), usado por el endpoint
// público de webhooks para validar el secret.
async function lookupClientIdBySessionId(sessionId) {
  const [rows] = await pool.execute(
    'SELECT client_id FROM wa_sessions WHERE session_id = ?',
    [sessionId],
  );
  return rows[0]?.client_id || null;
}

module.exports = {
  init,
  startSession,
  stopSession,
  deleteSession,
  dropSessionsForClient,
  sendMessage,
  listSessions,
  listSessionsByClient,
  getSession,
  lookupClientIdBySessionId,
  resumeSessions,
  normalizeJid,
};
