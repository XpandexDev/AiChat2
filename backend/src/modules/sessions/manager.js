const path = require('path');
const fs = require('fs/promises');
const axios = require('axios');
const QRCode = require('qrcode');
const pino = require('pino');
const config = require('../../config');
const pool = require('../../db/pool');
const webhooks = require('../webhooks/service');
const handoff = require('../handoff/service');
const blacklist = require('../blacklist/service');
const whitelist = require('../whitelist/service');
const { isBotActive } = require('../../lib/bot-schedule');
const { dispatchEvent } = require('../events/dispatcher');

const baileysPromise = import('@whiskeysockets/baileys');
const baileysLogger = pino({ level: 'silent' });

// Runtime state — Map keyed por session_id (globalmente único).
// Cada entrada lleva el clientId para resolver webhook config.
const sessions = new Map();
let io = null;

function init(socketIo) {
  io = socketIo;
  io.on('connection', (socket) => {
    // El middleware de auth (server.js) ya validó la sesión y fijó socket.data.
    if (socket.data.role === 'admin') {
      socket.join('admins');
      socket.emit('sessions:init', listSessions());
    } else if (socket.data.role === 'client') {
      socket.join(`client:${socket.data.clientId}`);
      socket.emit('sessions:init', listSessions().filter((s) => s.clientId === socket.data.clientId));
    }
  });
}

// Emisión con alcance: los admins lo ven todo; un cliente solo su sala.
function scopedEmit(event, clientId, data) {
  if (!io) return;
  let op = io.to('admins');
  if (clientId) op = op.to(`client:${clientId}`);
  op.emit(event, data);
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
    syncing: Boolean(session.syncing),
    syncProgress: session.syncProgress ?? null,
    syncedChats: session.syncedChats || 0,
    historyState: session.historyState || 'none',
    historyMessages: session.historyMessages || 0,
    historySyncedAt: session.historySyncedAt || null,
    updatedAt: session.updatedAt,
  };
}

function emitSessionUpdate(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || !io) return;
  scopedEmit('session:update', session.clientId, serializeSession(session));
}

// Emite un evento socket genérico al panel (usado por el handoff desde routes,
// para no acoplar las rutas a la instancia de socket.io que vive aquí).
// Si el payload lleva clientId, también llega a la sala de ese cliente.
const EVENT_BRIDGE = {
  'handoff:started': 'handoff.started',
  'handoff:resumed': 'handoff.resumed',
};

function emit(event, data) {
  scopedEmit(event, data?.clientId ?? null, data);
  // Puente al webhook de EVENTOS del cliente (API v1)
  const type = EVENT_BRIDGE[event];
  if (type && data?.clientId) dispatchEvent(data.clientId, type, data);
}

// --- Chat: ring buffer EN RAM como caché rápida del hilo reciente. La fuente
// de verdad es la BD (wa_messages / wa_conversations) con retención de 7 días;
// este buffer solo evita ir a BD en el camino caliente del mensaje. Estructura:
//   chatBuffer: clientId -> Map(contactJid -> { contactJid, senderName, isGroup,
//                                               lastAt, messages: [...] })
const CHAT_MSGS_PER_CONV = 50;    // últimos N mensajes por conversación
const CHAT_CONVS_PER_CLIENT = 100; // conversaciones por cliente (evicción LRU)
const chatBuffer = new Map();

// Mapa @lid -> teléfono (RAM). WhatsApp puede direccionar un 1:1 por @lid;
// n8n responde a ese @lid y, sin este mapa, el hilo saliente no casaría con
// el entrante (que agrupamos por teléfono) → chats partidos en dos.
const lidToPhone = new Map();

function rememberLid(lidJid, phoneJid) {
  if (!lidJid || !phoneJid || lidJid === phoneJid) return;
  lidToPhone.set(lidJid, phoneJid);
  if (lidToPhone.size > 2000) {
    lidToPhone.delete(lidToPhone.keys().next().value);
  }
}

// Identidad de HILO para un JID de destino: resuelve @lid a teléfono si lo conocemos.
function chatIdentity(jid) {
  const norm = normalizeJid(jid);
  if (!norm) return null;
  return lidToPhone.get(norm) || norm;
}

// El mismo mensaje puede llegar dos veces (evento en vivo + lote de
// sincronización al vincular): el UNIQUE de (client_id, wa_message_id) + el
// ON DUPLICATE KEY no-op lo hacen idempotente.
function persistChatMessage(clientId, contactJid, entry, conv) {
  const ts = new Date(entry.timestamp);
  pool.execute(
    `INSERT INTO wa_messages
       (client_id, contact_jid, direction, wa_message_id, body, sender_name,
        participant, is_group, has_media, msg_type, file_name, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE id = id`,
    [
      clientId, contactJid, entry.direction === 'out' ? 'out' : 'in',
      entry.id || null, entry.body || null, entry.senderName || null,
      entry.participant || null, conv.isGroup ? 1 : 0,
      entry.hasMedia ? 1 : 0, entry.msgType || null, entry.fileName || null,
      entry.source || null, ts,
    ],
  ).catch((err) => console.error('persistChatMessage:', err.message));

  pool.execute(
    `INSERT INTO wa_conversations (client_id, contact_jid, display_name, is_group, last_at, last_body)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       display_name = COALESCE(VALUES(display_name), display_name),
       is_group = VALUES(is_group),
       last_at = GREATEST(COALESCE(last_at, VALUES(last_at)), VALUES(last_at)),
       last_body = IF(VALUES(last_at) >= COALESCE(last_at, VALUES(last_at)), VALUES(last_body), last_body)`,
    [clientId, contactJid, conv.senderName || null, conv.isGroup ? 1 : 0, ts, entry.body || null],
  ).catch(() => {});
}

/**
 * Conversaciones desde el HISTÓRICO (BD, ventana de retención).
 * Sustituye a la lectura del buffer RAM para el panel y la API.
 */
async function listConversations(clientId, limit = 200) {
  const [rows] = await pool.execute(
    `SELECT client_id AS clientId, contact_jid AS contactJid, display_name AS senderName,
            is_group AS isGroup, last_at AS lastAt, last_body AS lastBody
     FROM wa_conversations
     WHERE client_id = ?
     ORDER BY last_at DESC
     LIMIT ?`,
    [clientId, Number(limit) || 200],
  );
  return rows.map((r) => ({
    clientId: r.clientId,
    contactJid: r.contactJid,
    senderName: r.senderName,
    isGroup: Boolean(r.isGroup),
    lastAt: r.lastAt ? new Date(r.lastAt).toISOString() : '',
    lastBody: r.lastBody || '',
  }));
}

/** Mensajes de un hilo, más antiguos primero. `before` pagina hacia atrás. */
async function listMessages(clientId, contactJid, { limit = 100, before = null } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const params = [clientId, contactJid];
  let where = 'client_id = ? AND contact_jid = ?';
  if (before) {
    where += ' AND created_at < ?';
    params.push(new Date(before));
  }
  params.push(lim);
  const [rows] = await pool.execute(
    `SELECT direction, wa_message_id AS id, body, sender_name AS senderName,
            participant, has_media AS hasMedia, msg_type AS msgType,
            file_name AS fileName, source, created_at AS timestamp
     FROM wa_messages WHERE ${where}
     ORDER BY created_at DESC LIMIT ?`,
    params,
  );
  return rows.reverse().map((m) => ({
    direction: m.direction,
    id: m.id,
    body: m.body || '',
    senderName: m.senderName,
    participant: m.participant,
    hasMedia: Boolean(m.hasMedia),
    msgType: m.msgType,
    fileName: m.fileName,
    source: m.source,
    timestamp: new Date(m.timestamp).toISOString(),
  }));
}

/** Conversaciones + últimos mensajes, para hidratar el panel de una vez. */
async function getConversationsWithMessages(clientId, perConv = 50) {
  const convs = await listConversations(clientId);
  const out = [];
  for (const c of convs) {
    out.push({ ...c, messages: await listMessages(clientId, c.contactJid, { limit: perConv }) });
  }
  return out;
}

function recordChatMessage(clientId, contactJid, entry, meta = {}) {
  if (!clientId || !contactJid) return;
  let convs = chatBuffer.get(clientId);
  if (!convs) {
    convs = new Map();
    chatBuffer.set(clientId, convs);
  }
  let conv = convs.get(contactJid);
  if (!conv) {
    conv = { contactJid, senderName: null, isGroup: false, lastAt: null, messages: [] };
    convs.set(contactJid, conv);
  } else {
    // Map conserva orden de inserción: re-insertar = marcar como más reciente (LRU).
    convs.delete(contactJid);
    convs.set(contactJid, conv);
  }
  if (meta.senderName) conv.senderName = meta.senderName;
  if (meta.isGroup !== undefined) conv.isGroup = Boolean(meta.isGroup);
  conv.lastAt = entry.timestamp;
  conv.messages.push(entry);
  if (conv.messages.length > CHAT_MSGS_PER_CONV) conv.messages.shift();

  // Persistencia con retención de 7 días (lib/retention.js purga lo viejo).
  // Best-effort: un fallo de BD nunca frena el mensaje de WhatsApp.
  persistChatMessage(clientId, contactJid, entry, conv);
  // Evicción: la conversación más antigua (primera del Map) sale.
  if (convs.size > CHAT_CONVS_PER_CLIENT) {
    const oldest = convs.keys().next().value;
    convs.delete(oldest);
  }
}

// Vista para GET /api/chat/recent — array serializable, más reciente primero.
function getRecentConversations(clientId = null) {
  const result = [];
  for (const [cid, convs] of chatBuffer) {
    if (clientId !== null && cid !== clientId) continue;
    for (const conv of convs.values()) {
      result.push({ clientId: cid, ...conv });
    }
  }
  result.sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
  return result;
}

// --- Métricas: contadores diarios (solo números, nunca contenido) ---
function bumpDailyStat(clientId, direction) {
  if (!clientId) return;
  const col = direction === 'in' ? 'msgs_in' : 'msgs_out';
  pool.execute(
    `INSERT INTO daily_stats (client_id, day, ${col}) VALUES (?, CURDATE(), 1)
     ON DUPLICATE KEY UPDATE ${col} = ${col} + 1`,
    [clientId],
  ).catch(() => {}); // best-effort: una métrica nunca frena un mensaje
}

// Estado del historial POR SESIÓN, persistido: el aviso de "sincronizando"
// dura segundos, pero la pregunta "¿tiene historial importado?" debe tener
// respuesta siempre — también tras un reinicio.
function persistHistoryState(session) {
  pool.execute(
    `UPDATE wa_sessions
     SET history_state = ?, history_messages = ?, history_synced_at = ?
     WHERE session_id = ?`,
    [
      session.historyState || 'none',
      session.historyMessages || 0,
      session.historySyncedAt ? new Date(session.historySyncedAt) : null,
      session.sessionId,
    ],
  ).catch((err) => console.error('persistHistoryState:', err.message));
}

// --- Importación del historial inicial (lote reciente de WhatsApp) ---
// Al vincular un número, WhatsApp manda los últimos mensajes de cada chat.
// Los guardamos para que el panel no arranque vacío. La retención de 7 días
// se encarga de purgar lo que quede fuera de la ventana.
const HISTORY_IMPORT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function importHistoryMessages(session, messages) {
  for (const msg of messages) {
    try {
      if (!msg?.message || !msg.key) continue;
      const ts = Number(msg.messageTimestamp) * 1000;
      if (!ts || Date.now() - ts > HISTORY_IMPORT_MAX_AGE_MS) continue; // fuera de retención
      const remoteJid = msg.key.remoteJid;
      if (!remoteJid) continue;
      const isGroup = String(remoteJid).endsWith('@g.us');
      const body = extractText(msg.message);
      if (!body && !hasMedia(msg.message)) continue;
      const chatJid = isGroup
        ? normalizeJid(remoteJid)
        : normalizeJid(msg.key.senderPn || remoteJid);
      if (!chatJid) continue;

      recordChatMessage(session.clientId, chatJid, {
        direction: msg.key.fromMe ? 'out' : 'in',
        id: msg.key.id || null,
        body,
        senderName: msg.pushName || null,
        participant: isGroup ? normalizeJid(msg.key.participantPn || msg.key.participant) : null,
        hasMedia: hasMedia(msg.message),
        msgType: messageType(msg.message),
        source: msg.key.fromMe ? 'history' : null,
        timestamp: new Date(ts).toISOString(),
      }, { senderName: isGroup ? null : (msg.pushName || null), isGroup });

      session.syncedChats = (session.syncedChats || 0) + 1;
    } catch { /* un mensaje corrupto no rompe la importación */ }
  }
}

// --- Acuses de entrega/lectura (ticks de WhatsApp, RAM) ---
const MESSAGE_STATUS_BY_CODE = { 2: 'sent', 3: 'delivered', 4: 'read', 5: 'read' };
const STATUS_RANK = { sent: 1, delivered: 2, read: 3 };
const messageStatusStore = new Map(); // `${clientId}|${msgId}` -> { status, at, to }

function recordMessageStatus(clientId, msgId, status, to) {
  const key = `${clientId}|${msgId}`;
  const prev = messageStatusStore.get(key);
  if (prev && STATUS_RANK[prev.status] >= STATUS_RANK[status]) return null;
  const entry = { status, at: new Date().toISOString(), to: to || prev?.to || null };
  messageStatusStore.set(key, entry);
  if (messageStatusStore.size > 2000) {
    messageStatusStore.delete(messageStatusStore.keys().next().value);
  }
  return entry;
}

function getMessageStatus(clientId, msgId) {
  return messageStatusStore.get(`${clientId}|${msgId}`) || null;
}

// --- Medios del chat: descarga bajo demanda (RAM, sin persistir) ---
// Para mensajes entrantes con media guardamos el WAMessage (solo el proto con
// las claves de descifrado — el archivo vive en los servidores de WhatsApp) y
// descargamos cuando el panel lo pide. Para salientes guardamos el buffer.
const MEDIA_STORE_MAX = 300;
const mediaStore = new Map(); // `${clientId}|${msgId}` -> {msg, sessionId} | {buffer, mimetype, fileName}
const mediaBytesCache = new Map(); // mismo key -> {buffer, mimetype, fileName} (últimas descargas)

function mediaKey(clientId, msgId) { return `${clientId}|${msgId}`; }

function rememberMedia(clientId, msgId, value) {
  if (!clientId || !msgId) return;
  mediaStore.set(mediaKey(clientId, msgId), value);
  if (mediaStore.size > MEDIA_STORE_MAX) {
    mediaStore.delete(mediaStore.keys().next().value);
  }
}

function mediaMetaFromMessage(message) {
  const m = message || {};
  const media = m.imageMessage || m.videoMessage || m.audioMessage
    || m.documentMessage || m.stickerMessage;
  if (!media) return null;
  return {
    mimetype: media.mimetype || 'application/octet-stream',
    fileName: m.documentMessage?.fileName || null,
  };
}

async function getChatMedia(clientId, msgId) {
  const key = mediaKey(clientId, msgId);
  const cached = mediaBytesCache.get(key);
  if (cached) return cached;

  const entry = mediaStore.get(key);
  if (!entry) return null;

  let result = null;
  if (entry.buffer) {
    result = { buffer: entry.buffer, mimetype: entry.mimetype, fileName: entry.fileName };
  } else if (entry.msg) {
    const { downloadMediaMessage } = await baileysPromise;
    const session = sessions.get(entry.sessionId);
    const buffer = await downloadMediaMessage(entry.msg, 'buffer', {}, {
      logger: baileysLogger,
      reuploadRequest: session?.sock ? session.sock.updateMediaMessage : undefined,
    });
    const meta = mediaMetaFromMessage(entry.msg.message) || {};
    result = {
      buffer,
      mimetype: meta.mimetype || 'application/octet-stream',
      fileName: meta.fileName,
    };
  }
  if (result) {
    mediaBytesCache.set(key, result);
    if (mediaBytesCache.size > 20) {
      mediaBytesCache.delete(mediaBytesCache.keys().next().value);
    }
  }
  return result;
}

// Envío de un adjunto desde el panel (composer): base64 → documento/imagen/audio/vídeo.
async function sendMediaMessage(sessionId, to, { dataBase64, mimetype, fileName, caption }, source = 'chatbot') {
  const session = requireReadySession(sessionId);
  const jid = normalizeJid(to);
  if (!jid) throw new Error('Destino inválido');
  const buffer = Buffer.from(String(dataBase64 || ''), 'base64');
  if (!buffer.length) throw new Error('Archivo vacío');
  if (buffer.length > 16 * 1024 * 1024) throw new Error('Archivo demasiado grande (máx. 16MB)');

  const mime = String(mimetype || 'application/octet-stream');
  let content;
  let msgType;
  if (mime.startsWith('image/') && mime !== 'image/webp') {
    content = { image: buffer, mimetype: mime, caption: caption || undefined };
    msgType = 'imageMessage';
  } else if (mime.startsWith('video/')) {
    content = { video: buffer, mimetype: mime, caption: caption || undefined };
    msgType = 'videoMessage';
  } else if (mime.startsWith('audio/')) {
    content = { audio: buffer, mimetype: mime };
    msgType = 'audioMessage';
  } else {
    content = { document: buffer, mimetype: mime, fileName: fileName || 'archivo' };
    msgType = 'documentMessage';
  }

  const sent = await session.sock.sendMessage(jid, content);
  const msgId = sent?.key?.id || null;
  if (msgId) rememberMedia(session.clientId, msgId, { buffer, mimetype: mime, fileName: fileName || null });

  return emitOutgoing(session, source, {
    id: msgId,
    to: jid,
    body: caption || `📎 ${fileName || 'archivo'}`,
    hasMedia: true,
    msgType,
    fileName: fileName || null,
  });
}

// Envía un archivo desde una URL como documento nativo (API v1). Reusa la
// validación por Content-Type real y los límites de los adjuntos automáticos:
// una página web o un tipo no permitido devuelven error, nunca se envían.
async function sendFileByUrl(sessionId, to, url, { fileName, caption } = {}, source = 'chatbot') {
  const session = requireReadySession(sessionId);
  const jid = normalizeJid(to);
  if (!jid) {
    const e = new Error('Destino inválido'); e.code = 'VALIDATION'; throw e;
  }
  const file = await downloadAttachment(url);
  if (!file) {
    const e = new Error('La URL no apunta a un archivo descargable de tipo permitido');
    e.code = 'VALIDATION';
    throw e;
  }
  const name = fileName || file.fileName;
  const sent = await session.sock.sendMessage(jid, {
    document: file.buffer,
    mimetype: file.mimetype,
    fileName: name,
    caption: caption || undefined,
  });
  const msgId = sent?.key?.id || null;
  if (msgId) {
    rememberMedia(session.clientId, msgId, { buffer: file.buffer, mimetype: file.mimetype, fileName: name });
  }
  return emitOutgoing(session, source, {
    id: msgId, to: jid, body: caption || `📎 ${name}`,
    hasMedia: true, msgType: 'documentMessage', fileName: name,
  });
}

// --- Grupos: nombre (subject) cacheado para el panel y el payload ---
const groupSubjectCache = new Map();   // `${clientId}|${groupJid}` -> subject
const groupSubjectPending = new Set();

function getGroupSubject(clientId, groupJid) {
  return groupSubjectCache.get(`${clientId}|${groupJid}`) || null;
}

// Fire-and-forget: no bloquea el flujo del mensaje. Cuando llega el subject,
// actualiza también el título del hilo ya existente en el buffer.
function ensureGroupSubject(session, groupJid) {
  const key = `${session.clientId}|${groupJid}`;
  if (groupSubjectCache.has(key) || groupSubjectPending.has(key) || !session.sock) return;
  groupSubjectPending.add(key);
  withTimeout(session.sock.groupMetadata(groupJid).catch(() => null), 8000)
    .then((meta) => {
      groupSubjectPending.delete(key);
      const subject = meta?.subject || null;
      if (!subject) return;
      groupSubjectCache.set(key, subject);
      const conv = chatBuffer.get(session.clientId)?.get(groupJid);
      if (conv) conv.senderName = subject;
    })
    .catch(() => groupSubjectPending.delete(key));
}

// --- Menciones salientes: '@34612345678' en el texto → mención real de WhatsApp ---
// n8n (o el composer del panel) solo tiene que escribir @<número> en el texto.
function mentionsFromText(text) {
  const matches = String(text || '').match(/@\d{6,15}/g) || [];
  return [...new Set(matches.map((m) => `${m.slice(1)}@s.whatsapp.net`))];
}

function withMentions(text) {
  const mentions = mentionsFromText(text);
  return mentions.length ? { text, mentions } : { text };
}

// --- Gestión de grupos: crear y unirse por enlace de invitación ---
function requireReadySession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || !session.sock || session.status !== 'ready') {
    const e = new Error(`La sesión ${sessionId} no está lista`);
    e.code = 'SESSION_NOT_READY';
    throw e;
  }
  return session;
}

async function createGroup(sessionId, subject, participants) {
  const session = requireReadySession(sessionId);
  const jids = (participants || []).map((p) => normalizeJid(p)).filter(Boolean);
  if (!subject || !jids.length) {
    const e = new Error('subject y al menos un participante son requeridos');
    e.code = 'VALIDATION';
    throw e;
  }
  const meta = await session.sock.groupCreate(String(subject), jids);
  groupSubjectCache.set(`${session.clientId}|${meta.id}`, meta.subject || String(subject));
  return { id: meta.id, subject: meta.subject || String(subject), participants: jids.length };
}

async function joinGroupByInvite(sessionId, invite) {
  const session = requireReadySession(sessionId);
  // Acepta el enlace completo (https://chat.whatsapp.com/XXXX) o solo el código
  const code = String(invite || '')
    .trim()
    .replace(/^https?:\/\/chat\.whatsapp\.com\//i, '')
    .replace(/[/?#].*$/, '');
  if (!code) {
    const e = new Error('Enlace o código de invitación requerido');
    e.code = 'VALIDATION';
    throw e;
  }
  const groupId = await session.sock.groupAcceptInvite(code);
  if (groupId) ensureGroupSubject(session, normalizeJid(groupId));
  return { id: groupId || null };
}

// --- Grupos: el bot responde solo si le HABLAN (mención, cita o palabra clave) ---
// El resto de mensajes de grupo se ven en el panel pero NO se reenvían a n8n
// (un bot que salta a cada mensaje quema al grupo). GROUP_REPLY_ALL=true en el
// .env revierte al comportamiento antiguo.

function jidNumber(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

// Identidades del bot en esta sesión (número real y LID, si lo hay).
function botIdentities(session) {
  const ids = new Set();
  const idNum = jidNumber(session.sock?.user?.id);
  if (idNum) ids.add(idNum);
  const lidNum = jidNumber(session.sock?.user?.lid);
  if (lidNum) ids.add(lidNum);
  if (session.connectedNumber) ids.add(String(session.connectedNumber));
  return ids;
}

// contextInfo puede colgar de cualquier tipo de contenido (texto, imagen...).
function getContextInfo(message) {
  if (!message) return null;
  for (const key of Object.keys(message)) {
    const ctx = message[key]?.contextInfo;
    if (ctx) return ctx;
  }
  return null;
}

function groupMessageAddressesBot(session, msg, bodyText) {
  if (config.GROUP_REPLY_ALL) return true;
  const ids = botIdentities(session);
  const ctx = getContextInfo(msg.message);

  // 1) Mención directa (@bot)
  const mentioned = (ctx?.mentionedJid || []).some((j) => ids.has(jidNumber(j)));
  if (mentioned) return true;

  // 2) Cita/reply a un mensaje del bot
  if (ctx?.participant && ids.has(jidNumber(ctx.participant))) return true;

  // 3) Palabra clave configurable (GROUP_TRIGGER_WORDS, comas)
  if (config.GROUP_TRIGGER_WORDS.length) {
    const text = ` ${String(bodyText || '').toLowerCase()} `;
    if (config.GROUP_TRIGGER_WORDS.some((w) => text.includes(w))) return true;
  }

  return false;
}

// --- Adjuntos: enviar archivos como documento nativo de WhatsApp ---
// Cuando n8n responde con enlaces de descarga (o con files:[{url}] explícito),
// la app descarga el archivo y lo manda como documento — el enlace del texto
// queda como fallback si la descarga falla. Validación por Content-Type real
// (no por la pinta de la URL): una página HTML de login nunca se adjunta.
const FILE_MAX_BYTES = 16 * 1024 * 1024; // 16MB
const FILE_MAX_PER_REPLY = 3;
const FILE_MIME_EXT = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'text/csv': 'csv',
  'application/zip': 'zip',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};
const FILE_EXT_ALLOW = new Set(Object.values(FILE_MIME_EXT));

function extractUrls(text) {
  const matches = String(text || '').match(/https?:\/\/[^\s<>"')\]]+/g) || [];
  // Sin duplicados, respetando el orden
  return [...new Set(matches.map((u) => u.replace(/[.,;:!?]+$/, '')))];
}

function fileNameFromResponse(url, headers, mimetype) {
  const cd = String(headers['content-disposition'] || '');
  let name = null;
  const star = cd.match(/filename\*=(?:UTF-8''|utf-8'')([^;]+)/i);
  const plain = cd.match(/filename="?([^";]+)"?/i);
  if (star) { try { name = decodeURIComponent(star[1].trim()); } catch { name = star[1].trim(); } }
  else if (plain) name = plain[1].trim();
  if (!name) {
    try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch { name = ''; }
  }
  name = name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
  const ext = FILE_MIME_EXT[mimetype];
  if (name && !/\.[a-z0-9]{2,5}$/i.test(name) && ext) name = `${name}.${ext}`;
  return name || `archivo.${ext || 'bin'}`;
}

// Descarga un enlace y devuelve {buffer, mimetype, fileName} si es un archivo
// adjuntable; null si es una página web, un tipo no permitido o pesa demasiado.
async function downloadAttachment(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 20000,
    maxRedirects: 5,
    maxContentLength: FILE_MAX_BYTES,
    maxBodyLength: FILE_MAX_BYTES,
    validateStatus: (s) => s >= 200 && s < 300,
  });
  let mimetype = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const fileName = fileNameFromResponse(url, res.headers, mimetype);
  if (!FILE_MIME_EXT[mimetype]) {
    // octet-stream genérico: solo si la extensión del nombre es de la lista
    const ext = (fileName.split('.').pop() || '').toLowerCase();
    if (mimetype === 'application/octet-stream' && FILE_EXT_ALLOW.has(ext)) {
      mimetype = Object.keys(FILE_MIME_EXT).find((k) => FILE_MIME_EXT[k] === ext) || mimetype;
    } else {
      return null;
    }
  }
  return { buffer: Buffer.from(res.data), mimetype, fileName };
}

// Envía como documento los adjuntos explícitos (files) y los enlaces de archivo
// detectados en el texto. Best-effort: un fallo deja el enlace como fallback.
async function sendFileAttachments(session, jid, replyText, explicitFiles) {
  const candidates = [];
  for (const f of (explicitFiles || [])) {
    candidates.push({ url: f.url, forcedName: f.fileName || null });
  }
  const explicitUrls = new Set(candidates.map((c) => c.url));
  for (const url of extractUrls(replyText)) {
    if (!explicitUrls.has(url)) candidates.push({ url, forcedName: null });
  }

  let sentCount = 0;
  for (const cand of candidates) {
    if (sentCount >= FILE_MAX_PER_REPLY) break;
    if (!session.sock) break;
    try {
      const file = await downloadAttachment(cand.url);
      if (!file) continue; // no es un archivo (p.ej. una página web) → el enlace basta
      const fileName = cand.forcedName || file.fileName;
      const sent = await session.sock.sendMessage(jid, {
        document: file.buffer,
        mimetype: file.mimetype,
        fileName,
      });
      emitOutgoing(session, 'file-attachment', {
        id: sent?.key?.id || null, to: jid, body: `📎 ${fileName}`,
      });
      sentCount += 1;
      await new Promise((r) => setTimeout(r, 800));
    } catch (err) {
      console.error('adjunto no enviado (queda el enlace):', cand.url, '-', err.message);
    }
  }
}

// --- Perfil de contacto (foto, "info", perfil de empresa) ---
// Se consulta bajo demanda vía la sesión Baileys del cliente y se cachea en RAM
// (los datos cambian poco). Cada fetch es fail-safe: la privacidad del contacto
// puede bloquear foto/estado y eso NO es un error.
const CONTACT_PROFILE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const contactProfileCache = new Map(); // `${clientId}|${jid}` -> { value, expiresAt }

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
}

async function getContactProfile(clientId, rawJid) {
  const jid = normalizeJid(rawJid);
  if (!clientId || !jid) return null;

  const key = `${clientId}|${jid}`;
  const cached = contactProfileCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  // Sesión viva del cliente para consultar
  const session = [...sessions.values()].find(
    (s) => s.clientId === clientId && s.sock && s.status === 'ready',
  );
  if (!session) {
    // Sin sesión no podemos consultar; si hay caché caducada, mejor eso que nada.
    return cached ? cached.value : null;
  }

  const value = {
    jid,
    phone: jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0] : null,
    isGroup: jid.endsWith('@g.us'),
    pictureUrl: null,
    about: null,
    aboutSetAt: null,
    business: null,
    fetchedAt: new Date().toISOString(),
  };

  try {
    value.pictureUrl = (await withTimeout(
      session.sock.profilePictureUrl(jid, 'image', 5000).catch(() => undefined), 6000,
    )) || null;
  } catch { /* privacidad o sin foto */ }

  if (!value.isGroup) {
    try {
      const st = await withTimeout(session.sock.fetchStatus(jid).catch(() => undefined), 5000);
      const entry = Array.isArray(st) ? st[0] : null;
      if (entry?.status?.status) {
        value.about = String(entry.status.status);
        value.aboutSetAt = entry.status.setAt ? new Date(entry.status.setAt).toISOString() : null;
      }
    } catch { /* privacidad */ }

    try {
      const biz = await withTimeout(session.sock.getBusinessProfile(jid).catch(() => undefined), 5000);
      if (biz && (biz.description || biz.category || biz.email || biz.address
          || (Array.isArray(biz.website) && biz.website.length))) {
        value.business = {
          description: biz.description || null,
          category: biz.category || null,
          email: biz.email || null,
          website: Array.isArray(biz.website) ? biz.website.filter(Boolean) : [],
          address: biz.address || null,
        };
      }
    } catch { /* no es cuenta business */ }
  }

  contactProfileCache.set(key, { value, expiresAt: Date.now() + CONTACT_PROFILE_TTL_MS });
  // Poda simple para que la caché no crezca sin límite
  if (contactProfileCache.size > 500) {
    const oldest = contactProfileCache.keys().next().value;
    contactProfileCache.delete(oldest);
  }
  return value;
}

// Emisión + registro unificado de mensajes SALIENTES (antes había 4 copias del
// mismo objeto con distinto source: auto-reply/webhook-response/form-link/chatbot).
function emitOutgoing(session, source, message) {
  // Identidad del hilo: si el destino es un @lid conocido, agrupamos por el
  // teléfono real (misma conversación que los mensajes entrantes).
  const contactJid = chatIdentity(message.to);
  const payload = {
    type: 'outgoing_message',
    source,
    sessionId: session.sessionId,
    clientId: session.clientId,
    timestamp: new Date().toISOString(),
    message: { ...message, contactJid },
  };
  bumpDailyStat(session.clientId, 'out');
  recordChatMessage(session.clientId, contactJid, {
    direction: 'out',
    id: message.id || null,
    body: message.body,
    source,
    hasMedia: Boolean(message.hasMedia),
    msgType: message.msgType || null,
    fileName: message.fileName || null,
    timestamp: payload.timestamp,
  });
  scopedEmit('message:outgoing', session.clientId, payload);
  dispatchEvent(session.clientId, 'message.sent', {
    id: message.id || null,
    to: contactJid,
    body: message.body,
    source,
    hasMedia: Boolean(message.hasMedia),
  });
  return payload;
}

// --- Estado "bot activo" por cliente (on/off manual + horario semanal) ---
// Cache en memoria con TTL corto para no pegar a BD en cada mensaje entrante.
// El cooldown evita spamear el aviso automático al mismo contacto fuera de horario.
// (App single-process: un aviso duplicado tras un reinicio es inocuo.)
const BOT_STATE_TTL_MS = 30000;
const AUTO_REPLY_COOLDOWN_MS = 60 * 60 * 1000; // 1h
const botStateCache = new Map();    // clientId -> { value, expiresAt }
const autoReplyCooldown = new Map(); // `${clientId}:${jid}` -> timestamp

async function getBotState(clientId) {
  const cached = botStateCache.get(clientId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const [[c]] = await pool.execute(
    'SELECT bot_enabled, schedule_enabled, timezone, auto_reply_text FROM clients WHERE id = ?',
    [clientId],
  );
  let value = null;
  if (c) {
    const [windows] = await pool.execute(
      "SELECT weekday, TIME_FORMAT(start_time,'%H:%i') AS start, TIME_FORMAT(end_time,'%H:%i') AS end "
      + 'FROM client_schedule WHERE client_id = ?',
      [clientId],
    );
    value = {
      bot_enabled: !!c.bot_enabled,
      schedule_enabled: !!c.schedule_enabled,
      timezone: c.timezone,
      auto_reply_text: c.auto_reply_text,
      windows,
    };
  }
  botStateCache.set(clientId, { value, expiresAt: Date.now() + BOT_STATE_TTL_MS });
  return value;
}

// Invalida la cache de un cliente (lo llama el panel al togglear el bot o guardar horario).
function invalidateBotState(clientId) {
  botStateCache.delete(clientId);
}

function autoReplyKey(clientId, jid) {
  return `${clientId}:${jid}`;
}

// Peek SIN mutar: ¿toca enviar el aviso a este contacto? (cooldown no vencido → no).
// Purga perezosa la entrada vencida que se consulta.
function canSendAutoReply(clientId, jid) {
  const key = autoReplyKey(clientId, jid);
  const last = autoReplyCooldown.get(key);
  if (last == null) return true;
  if (Date.now() - last < AUTO_REPLY_COOLDOWN_MS) return false;
  autoReplyCooldown.delete(key); // vencida: la limpiamos
  return true;
}

// Marca el cooldown SOLO tras un envío exitoso (un envío fallido no bloquea el reintento).
function markAutoReplySent(clientId, jid) {
  autoReplyCooldown.set(autoReplyKey(clientId, jid), Date.now());
}

// Barrido periódico para que autoReplyCooldown no crezca sin límite (contactos
// que escriben una vez fuera de horario y nunca más). unref() para no bloquear el cierre.
const autoReplySweep = setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of autoReplyCooldown) {
    if (now - ts > AUTO_REPLY_COOLDOWN_MS) autoReplyCooldown.delete(key);
  }
}, AUTO_REPLY_COOLDOWN_MS);
if (autoReplySweep.unref) autoReplySweep.unref();

function updateSession(sessionId, patch) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const prevStatus = session.status;
  Object.assign(session, patch, { updatedAt: new Date().toISOString() });
  // Eventos de conexión para el webhook del cliente
  if (patch.status && patch.status !== prevStatus) {
    if (patch.status === 'ready') {
      dispatchEvent(session.clientId, 'session.connected', {
        sessionId, number: session.connectedNumber || null,
      });
    } else if (prevStatus === 'ready') {
      dispatchEvent(session.clientId, 'session.disconnected', {
        sessionId, status: patch.status,
      });
    }
  }
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

// Construye la URL final del formulario web que se envía por WhatsApp cuando n8n
// lo ordena. Añade el teléfono del contacto (solo en 1:1, no en grupos) y los
// campos `prefill` como query params, para que el formulario / n8n sepan quién lo
// rellena. La URL base ya viene validada como http/https por webhooks.validateUrl.
function buildFormUrl(form, contactJid) {
  const url = new URL(form.url);
  const jid = contactJid ? String(contactJid) : '';
  if (jid.endsWith('@s.whatsapp.net')) {
    const phone = jid.split('@')[0].replace(/\D/g, '');
    if (phone && !url.searchParams.has('telefono')) url.searchParams.set('telefono', phone);
  }
  if (form.prefill && typeof form.prefill === 'object') {
    for (const [k, v] of Object.entries(form.prefill)) {
      if (v === null || v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
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

  // Sincronización inicial: al vincular, WhatsApp envía un lote de chats
  // recientes. Lo importamos al histórico (retención de 7 días) y publicamos
  // el progreso para que el panel muestre "Sincronizando chats…".
  sock.ev.on('messaging-history.set', ({ messages, isLatest, progress }) => {
    const pct = typeof progress === 'number' ? Math.round(progress) : null;
    session.syncing = !isLatest;
    session.syncProgress = pct;
    session.historyState = 'syncing';
    importHistoryMessages(session, messages || []);
    session.historyMessages = session.syncedChats || 0;
    if (isLatest) {
      session.syncing = false;
      session.syncProgress = 100;
      session.historyState = 'imported';
      session.historySyncedAt = new Date().toISOString();
      console.log(`sync: ${session.sessionId} completado (${session.historyMessages} mensajes importados)`);
    }
    persistHistoryState(session);
    emitSessionUpdate(session.sessionId);
  });

  // Ticks de WhatsApp (entregado/leído) de NUESTROS mensajes → estado por id
  // consultable por API + eventos message.delivered / message.read.
  sock.ev.on('messages.update', (updates) => {
    for (const u of updates || []) {
      if (!u.key?.fromMe || !u.key.id) continue;
      const mapped = MESSAGE_STATUS_BY_CODE[u.update?.status];
      if (!mapped) continue;
      const to = chatIdentity(u.key.remoteJid);
      const entry = recordMessageStatus(session.clientId, u.key.id, mapped, to);
      if (entry && mapped !== 'sent') {
        dispatchEvent(session.clientId, `message.${mapped}`, {
          id: u.key.id, to, status: mapped, at: entry.at,
        });
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key?.fromMe) continue;

      // Grupo vs 1:1: en un grupo, remoteJid es el JID del grupo y el que ESCRIBE
      // está en participant (participantPn = su teléfono si WhatsApp lo direcciona
      // por @lid); msg.pushName es su nombre visible. En 1:1, participant queda null.
      // Mantenemos from = remoteJid → la memoria de n8n sigue siendo por grupo, y
      // los nuevos campos permiten diferenciar quién habla dentro del grupo.
      const remoteJid = msg.key.remoteJid;
      const isGroup = String(remoteJid || '').endsWith('@g.us');

      // Identidad del contacto por TELÉFONO (estable aunque WhatsApp direccione por
      // @lid): senderPn es el número real; si no viene, caemos al remoteJid.
      // replyJid = el JID EXACTO al que responder (lo que mandó WhatsApp), para no
      // arriesgar la entrega. Handoff, blacklist y el CHAT del panel casan por
      // contactJid — por eso viaja también en el payload (el 'from' puede ser @lid
      // y no casaría con el 'to' normalizado de los mensajes salientes).
      const replyJid = remoteJid;
      let contactJid = normalizeJid(msg.key.senderPn || remoteJid);

      // Si este 1:1 llega direccionado por @lid, aprendemos el mapeo al teléfono
      // real para que las RESPUESTAS (que van al @lid) caigan en el mismo hilo.
      if (!isGroup && String(remoteJid || '').endsWith('@lid') && msg.key.senderPn) {
        rememberLid(normalizeJid(remoteJid), contactJid);
      }

      // Sin senderPn el contactJid se queda en @lid, y las listas (blanca/negra)
      // están escritas por teléfono: resolvemos con el mapeo aprendido para no
      // silenciar por error a un número que SÍ está en la lista blanca.
      if (!isGroup) contactJid = chatIdentity(contactJid);

      // Identidad del HILO en el chat del panel: en grupos, el grupo entero;
      // en 1:1, el teléfono del contacto.
      const chatJid = isGroup ? normalizeJid(remoteJid) : contactJid;

      // Bloque `contact` de primer nivel para n8n: identidad del contacto lista
      // para usar en prompts (saludar por nombre, verificar por teléfono...).
      // Si el perfil enriquecido ya está en caché (lo pidió el panel), viaja
      // también — sin coste de latencia: NUNCA se consulta en caliente aquí.
      const phoneOf = (j) => (String(j || '').endsWith('@s.whatsapp.net') ? j.split('@')[0] : null);
      const cachedProfile = contactProfileCache.get(`${session.clientId}|${contactJid}`)?.value || null;
      if (isGroup) ensureGroupSubject(session, chatJid); // async, no bloquea
      const contact = {
        jid: contactJid,
        phone: phoneOf(contactJid),
        name: msg.pushName || null,
        isGroup,
        groupJid: isGroup ? remoteJid : null,
        groupSubject: isGroup ? getGroupSubject(session.clientId, chatJid) : null,
        participantPhone: isGroup ? phoneOf(normalizeJid(msg.key.participantPn || msg.key.participant)) : null,
        about: cachedProfile?.about || null,
        business: cachedProfile?.business || null,
      };

      const payload = {
        type: 'incoming_message',
        source: 'whatsapp-web',
        sessionId: session.sessionId,
        clientId: session.clientId,
        mode: session.mode,
        timestamp: new Date().toISOString(),
        contact,
        message: {
          id: msg.key.id || null,
          from: remoteJid,
          contactJid: chatJid,
          body: extractText(msg.message),
          type: messageType(msg.message),
          hasMedia: hasMedia(msg.message),
          isGroup,
          groupJid: isGroup ? remoteJid : null,
          groupSubject: contact.groupSubject,
          participant: isGroup ? normalizeJid(msg.key.participantPn || msg.key.participant) : null,
          senderName: msg.pushName || null,
        },
      };

      // Media entrante: guardamos el proto (claves de descifrado) para poder
      // descargarla cuando el panel la pida — el archivo vive en WhatsApp.
      if (payload.message.hasMedia && payload.message.id) {
        rememberMedia(session.clientId, payload.message.id, {
          msg, sessionId: session.sessionId,
        });
      }

      bumpDailyStat(session.clientId, 'in');
      recordChatMessage(session.clientId, chatJid, {
        direction: 'in',
        id: payload.message.id,
        body: payload.message.body,
        senderName: payload.message.senderName,
        participant: payload.message.participant,
        hasMedia: payload.message.hasMedia,
        msgType: payload.message.type,
        timestamp: payload.timestamp,
      }, { senderName: isGroup ? contact.groupSubject : payload.message.senderName, isGroup });

      scopedEmit('message:incoming', session.clientId, payload);
      dispatchEvent(session.clientId, 'message.received', {
        message: payload.message,
        contact,
      });

      // GRUPOS: responder solo si le hablan al bot (mención/cita/palabra clave).
      // El mensaje ya está en el panel y en el buffer del chat — el bot lo
      // "escucha" (viajará como contexto) pero no contesta.
      if (isGroup && !groupMessageAddressesBot(session, msg, payload.message.body)) {
        continue;
      }

      // Cuando SÍ responde en un grupo, adjuntamos lo último que se dijo (del
      // buffer RAM) para que n8n tenga el contexto de lo no reenviado.
      if (isGroup) {
        const conv = chatBuffer.get(session.clientId)?.get(chatJid);
        const recent = (conv?.messages || []).slice(-11, -1); // sin el actual
        payload.groupContext = recent.map((m) => ({
          de: m.direction === 'out' ? 'bot' : (m.senderName || 'participante'),
          texto: m.body,
        }));
      }

      // Blacklist: números marcados como "sin bot" (cliente/admin) → silencio
      // total. El bot los ignora por completo: ni reenvío a n8n ni aviso.
      let isBlocked = false;
      try {
        isBlocked = await blacklist.isBlacklisted(session.clientId, contactJid);
      } catch (e) {
        isBlocked = false; // fail-open
      }
      if (isBlocked) continue;

      // Whitelist ACTIVABLE: si el cliente la tiene encendida, el bot solo
      // atiende a los números de la lista (modo pruebas / bot restringido).
      // Apagada, no aplica. Fail-open si la BD falla.
      let blockedByWhitelist = false;
      try {
        blockedByWhitelist = await whitelist.isBlockedByWhitelist(session.clientId, contactJid);
      } catch (e) {
        blockedByWhitelist = false;
      }
      if (blockedByWhitelist) {
        console.error(`[whitelist] cliente ${session.clientId}: ${contactJid} NO está en la lista blanca → el bot no responde`);
        continue;
      }

      // Handoff: si el contacto está en modo humano, el bot calla — no reenviamos
      // a n8n ni auto-respondemos. El panel ya ha visto el mensaje (emit de arriba)
      // y un humano lo atiende. Fail-open: si la BD falla, el bot sigue operando.
      let handoffPaused = false;
      try {
        handoffPaused = await handoff.isPaused(session.clientId, contactJid);
      } catch (e) {
        handoffPaused = false;
      }
      if (handoffPaused) continue;

      // Bot apagado (manual) o fuera de horario: el bot no responde y, con
      // cooldown por contacto, envía UN aviso automático si está configurado.
      let botState = null;
      try {
        botState = await getBotState(session.clientId);
      } catch (e) {
        botState = null; // fail-open: si la BD falla, el bot sigue operando
      }
      if (botState && !isBotActive(botState, new Date())) {
        if (botState.auto_reply_text && replyJid && !replyJid.endsWith('@g.us')
            && session.sock && canSendAutoReply(session.clientId, contactJid)) {
          try {
            const sent = await session.sock.sendMessage(replyJid, { text: botState.auto_reply_text });
            // Marca el cooldown SOLO tras enviar con éxito (un fallo no bloquea el reintento).
            markAutoReplySent(session.clientId, contactJid);
            emitOutgoing(session, 'auto-reply', {
              id: sent?.key?.id || null, to: replyJid, body: botState.auto_reply_text,
            });
          } catch (err) {
            console.error('auto-reply error:', err.message);
          }
        }
        continue; // no reenvía a n8n
      }

      try {
        const reply = await webhooks.forwardIncoming(session.clientId, payload, {
          connectedNumber: session.connectedNumber,
        });
        updateSession(session.sessionId, { lastError: null });
        if (reply && session.sock) {
          const jid = normalizeJid(reply.to);
          if (jid) {
            // Protocolo con n8n: \n = salto de línea dentro del mensaje,
            // \n\n = separador entre mensajes WhatsApp distintos. Si n8n solo
            // ordena un formulario (text vacío), chunks queda vacío y no se envía
            // ningún mensaje de texto (solo el enlace del formulario, más abajo).
            const chunks = String(reply.text || '')
              .split(/\n{2,}/)
              .map((p) => p.trim())
              .filter(Boolean);

            for (let i = 0; i < chunks.length; i++) {
              try {
                const sent = await session.sock.sendMessage(jid, withMentions(chunks[i]));
                emitOutgoing(session, 'webhook-response', {
                  id: sent?.key?.id || null, to: jid, body: chunks[i],
                });
                if (i < chunks.length - 1) {
                  await new Promise((r) => setTimeout(r, 800));
                }
              } catch (sendErr) {
                console.error('Error enviando respuesta de webhook:', sendErr.message);
                break;
              }
            }

            // Adjuntos: enlaces de archivo del texto (y files:[] explícito de n8n)
            // se envían además como documento nativo de WhatsApp. Best-effort.
            try {
              await sendFileAttachments(session, jid, reply.text, reply.files);
            } catch (attErr) {
              console.error('sendFileAttachments error:', attErr.message);
            }

            // Formulario web: si n8n ordenó un formulario, enviamos su ENLACE como
            // mensaje aparte, tras el texto. (Baileys no puede mandar Flows nativos
            // de WhatsApp con garantías; un enlace funciona en el 100% de clientes.)
            if (reply.form && reply.form.url && webhooks.validateUrl(reply.form.url)) {
              try {
                const formUrl = buildFormUrl(reply.form, contactJid);
                const formText = reply.form.title ? `${reply.form.title}:\n${formUrl}` : formUrl;
                if (chunks.length > 0) await new Promise((r) => setTimeout(r, 800));
                const sent = await session.sock.sendMessage(jid, { text: formText });
                emitOutgoing(session, 'form-link', {
                  id: sent?.key?.id || null, to: jid, body: formText,
                });
              } catch (formErr) {
                console.error('Error enviando enlace de formulario:', formErr.message);
              }
            }

            // Handoff: el agente decidió ceder la conversación a un humano. Tras
            // enviar el "te atiende una persona", marcamos el contacto en modo
            // humano para que sus próximos mensajes no lleguen al bot. Excluimos
            // grupos (@g.us): un grupo no debe pausarse por un mensaje suelto.
            if (reply.handoff === true && !replyJid.endsWith('@g.us')) {
              try {
                // contactJid = identidad por teléfono (clave); replyJid = JID exacto al que responder.
                await handoff.start(session.clientId, contactJid, {
                  replyJid,
                  motivo: reply.handoff_motivo,
                  resumen: reply.handoff_resumen,
                  sessionId: session.sessionId,
                  ttlMinutes: config.HANDOFF_TTL_MINUTES,
                });
                emit('handoff:started', {
                  clientId: session.clientId,
                  sessionId: session.sessionId,
                  contactJid,
                  motivo: reply.handoff_motivo || null,
                  resumen: reply.handoff_resumen || null,
                  timestamp: new Date().toISOString(),
                });
              } catch (e) {
                console.error('handoff.start error:', e.message);
              }
            }
          }
        }
      } catch (error) {
        const detail = webhooks.formatError(error);
        console.error(`[webhook] cliente ${session.clientId} ${contactJid}: fallo al reenviar a n8n → ${detail}`);
        updateSession(session.sessionId, {
          lastError: `Error enviando webhook entrante: ${detail}`,
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

  // Estado del historial ya conocido (persistido) para no perderlo al reiniciar
  const [[histRow]] = await pool.execute(
    'SELECT history_state, history_messages, history_synced_at FROM wa_sessions WHERE session_id = ?',
    [sessionId],
  );

  const session = {
    sessionId,
    clientId,
    mode,
    historyState: histRow?.history_state || 'none',
    historyMessages: histRow?.history_messages || 0,
    historySyncedAt: histRow?.history_synced_at
      ? new Date(histRow.history_synced_at).toISOString() : null,
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

  scopedEmit('session:removed', session?.clientId ?? null, warning ? { sessionId, warning } : { sessionId });
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
    scopedEmit('session:removed', clientId, { sessionId: sid });
    count += 1;
  }
  return count;
}

async function sendMessage(sessionId, to, text, source = 'chatbot') {
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

  const sent = await session.sock.sendMessage(jid, withMentions(String(text)));

  return emitOutgoing(session, source, {
    id: sent?.key?.id || null,
    to: jid,
    body: text,
  });
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
    `SELECT session_id, status, phone_number, last_error, created_at, updated_at,
            history_state, history_messages, history_synced_at
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
      historyState: row.history_state || 'none',
      historyMessages: row.history_messages || 0,
      historySyncedAt: row.history_synced_at
        ? new Date(row.history_synced_at).toISOString() : null,
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
  emit,
  invalidateBotState,
  getRecentConversations,
  listConversations,
  listMessages,
  getConversationsWithMessages,
  getContactProfile,
  getChatMedia,
  sendMediaMessage,
  sendFileByUrl,
  getMessageStatus,
  createGroup,
  joinGroupByInvite,
};
