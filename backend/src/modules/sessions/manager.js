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
const { isBotActive } = require('../../lib/bot-schedule');

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

// Emite un evento socket genérico al panel (usado por el handoff desde routes,
// para no acoplar las rutas a la instancia de socket.io que vive aquí).
function emit(event, data) {
  if (io) io.emit(event, data);
}

// --- Chat en vivo: ring buffer de mensajes EN RAM (sin BD, por decisión de
// producto: no se persiste contenido de conversaciones). Da contexto reciente
// al abrir el panel; un reinicio lo vacía. Estructura:
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
  recordChatMessage(session.clientId, contactJid, {
    direction: 'out',
    id: message.id || null,
    body: message.body,
    source,
    timestamp: payload.timestamp,
  });
  if (io) io.emit('message:outgoing', payload);
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
      const contactJid = normalizeJid(msg.key.senderPn || remoteJid);

      // Si este 1:1 llega direccionado por @lid, aprendemos el mapeo al teléfono
      // real para que las RESPUESTAS (que van al @lid) caigan en el mismo hilo.
      if (!isGroup && String(remoteJid || '').endsWith('@lid') && msg.key.senderPn) {
        rememberLid(normalizeJid(remoteJid), contactJid);
      }

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

      recordChatMessage(session.clientId, chatJid, {
        direction: 'in',
        id: payload.message.id,
        body: payload.message.body,
        senderName: payload.message.senderName,
        participant: payload.message.participant,
        hasMedia: payload.message.hasMedia,
        timestamp: payload.timestamp,
      }, { senderName: isGroup ? contact.groupSubject : payload.message.senderName, isGroup });

      if (io) io.emit('message:incoming', payload);

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

  const sent = await session.sock.sendMessage(jid, withMentions(String(text)));

  return emitOutgoing(session, 'chatbot', {
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
  emit,
  invalidateBotState,
  getRecentConversations,
  getContactProfile,
  createGroup,
  joinGroupByInvite,
};
