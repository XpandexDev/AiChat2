const express = require('express');
const pool = require('../../db/pool');
const manager = require('../sessions/manager');
const handoff = require('../handoff/service');
const whitelist = require('../whitelist/service');
const { requireApiKey } = require('../../middleware/api-key');
const { makeApiLimiter } = require('../../middleware/rate-limit');
const { auditLog } = require('../../middleware/audit');
const { openapiSpec } = require('./openapi');
const clientsService = require('../clients/service');
const { invalidateEventsConfig } = require('../events/dispatcher');

// Idempotencia de envíos: cabecera Idempotency-Key → misma respuesta 24h (RAM).
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const idempotencyStore = new Map(); // `${clientId}|${key}` -> { response, expiresAt }

function idemGet(clientId, key) {
  const e = idempotencyStore.get(`${clientId}|${key}`);
  return e && e.expiresAt > Date.now() ? e.response : null;
}

function idemSet(clientId, key, response) {
  idempotencyStore.set(`${clientId}|${key}`, { response, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS });
  if (idempotencyStore.size > 5000) {
    idempotencyStore.delete(idempotencyStore.keys().next().value);
  }
}

// API pública v1 — auth por API key de cliente. Cada key accede EXCLUSIVAMENTE
// a los datos de su cliente (req.clientId lo fija el middleware).
// Errores uniformes: { error: { code, message } }.

const router = express.Router();

// La spec es pública (no revela secretos) — ANTES del auth.
router.get('/openapi.json', (_req, res) => res.json(openapiSpec));

router.use(requireApiKey);
router.use(makeApiLimiter());

function fail(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

function mapError(res, err) {
  if (err.code === 'VALIDATION') return fail(res, 400, 'validation', err.message);
  if (err.code === 'SESSION_NOT_READY') return fail(res, 409, 'session_not_ready', 'La sesión de WhatsApp del cliente no está conectada');
  return fail(res, 500, 'internal', err.message);
}

// Sesión "ready" del cliente (para enviar sin que el integrador sepa el sessionId).
function readySessionOf(clientId) {
  return manager.listSessions().find((s) => s.clientId === clientId && s.status === 'ready') || null;
}

// --- GET /v1/me — identidad + estado de la conexión WhatsApp ---
router.get('/me', async (req, res) => {
  try {
    const [[client]] = await pool.execute(
      'SELECT id, name FROM clients WHERE id = ?', [req.clientId],
    );
    const sessions = manager.listSessions().filter((s) => s.clientId === req.clientId);
    const ready = sessions.find((s) => s.status === 'ready') || null;
    return res.json({
      client: { id: client.id, name: client.name },
      whatsapp: {
        connected: Boolean(ready),
        status: ready ? 'ready' : (sessions[0]?.status || 'stopped'),
        number: ready?.connectedNumber || null,
      },
    });
  } catch (err) {
    return mapError(res, err);
  }
});

// --- POST /v1/messages — enviar o INICIAR una conversación ---
// { to, text } | { to, file: { url | dataBase64, mimetype?, fileName?, caption? } }
router.post('/messages', async (req, res) => {
  const to = String(req.body?.to || '').trim();
  const text = req.body?.text != null ? String(req.body.text) : '';
  const file = req.body?.file;
  if (!to) return fail(res, 400, 'validation', 'to es requerido (número internacional o JID)');
  if (!text.trim() && !file) return fail(res, 400, 'validation', 'text o file son requeridos');

  const session = readySessionOf(req.clientId);
  if (!session) return fail(res, 409, 'session_not_ready', 'La sesión de WhatsApp del cliente no está conectada');

  // Idempotencia: un reintento con la misma clave NO reenvía el WhatsApp.
  const idemKey = String(req.headers['idempotency-key'] || '').slice(0, 128) || null;
  if (idemKey) {
    const cached = idemGet(req.clientId, idemKey);
    if (cached) {
      res.set('Idempotent-Replay', 'true');
      return res.status(201).json(cached);
    }
  }

  try {
    let result;
    if (file && file.url) {
      result = await manager.sendFileByUrl(session.sessionId, to, String(file.url), {
        fileName: file.fileName, caption: file.caption,
      }, 'api');
    } else if (file && file.dataBase64) {
      result = await manager.sendMediaMessage(session.sessionId, to, {
        dataBase64: file.dataBase64, mimetype: file.mimetype,
        fileName: file.fileName, caption: file.caption,
      }, 'api');
    } else {
      result = await manager.sendMessage(session.sessionId, to, text, 'api');
    }
    auditLog(null, 'api.message_send', 'client', String(req.clientId),
      { to: to.split('@')[0], media: Boolean(file) }, req).catch(() => {});
    const responseBody = {
      id: result?.message?.id || null,
      to: result?.message?.to || to,
      timestamp: result?.timestamp,
    };
    if (idemKey) idemSet(req.clientId, idemKey, responseBody);
    return res.status(201).json(responseBody);
  } catch (err) {
    return mapError(res, err);
  }
});

// --- Estado de un mensaje enviado (ticks de WhatsApp, RAM) ---
router.get('/messages/:id/status', (req, res) => {
  const st = manager.getMessageStatus(req.clientId, String(req.params.id || ''));
  if (!st) return fail(res, 404, 'not_found', 'Sin estado para ese id (o expiró del buffer)');
  return res.json({ id: req.params.id, status: st.status, to: st.to, updatedAt: st.at });
});

// --- Webhook de EVENTOS del cliente (configurable por API) ---
router.get('/events-webhook', async (req, res) => {
  try {
    const cfg = await clientsService.getEventsWebhook(req.clientId);
    return res.json({ url: cfg?.url || null, secret: cfg?.secret || null });
  } catch (err) {
    return mapError(res, err);
  }
});

router.put('/events-webhook', async (req, res) => {
  const url = req.body?.url != null ? String(req.body.url).trim() : '';
  if (url && !/^https?:\/\//.test(url)) {
    return fail(res, 400, 'validation', 'url debe ser http(s) — o vacía para desactivar los eventos');
  }
  try {
    const cfg = await clientsService.setEventsWebhook(
      req.clientId, url, req.body?.regenerateSecret === true,
    );
    invalidateEventsConfig(req.clientId);
    auditLog(null, 'api.events_webhook_update', 'client', String(req.clientId),
      { configured: Boolean(cfg.url) }, req).catch(() => {});
    return res.json(cfg);
  } catch (err) {
    return mapError(res, err);
  }
});

// --- Conversaciones (buffer RAM: contexto reciente, NO histórico persistente) ---
router.get('/conversations', (req, res) => {
  const list = manager.getRecentConversations(req.clientId).map((c) => ({
    contactJid: c.contactJid,
    name: c.senderName,
    isGroup: c.isGroup,
    lastAt: c.lastAt,
    lastMessage: c.messages[c.messages.length - 1]?.body || '',
  }));
  return res.json({ conversations: list });
});

router.get('/conversations/:jid/messages', (req, res) => {
  const jid = manager.normalizeJid(req.params.jid);
  if (!jid) return fail(res, 400, 'validation', 'jid inválido');
  const conv = manager.getRecentConversations(req.clientId)
    .find((c) => c.contactJid === jid);
  if (!conv) return fail(res, 404, 'not_found', 'Sin conversación reciente con ese contacto (el buffer no es histórico)');
  return res.json({
    contactJid: conv.contactJid,
    name: conv.senderName,
    isGroup: conv.isGroup,
    messages: conv.messages.map((m) => ({
      direction: m.direction,
      id: m.id,
      body: m.body,
      senderName: m.senderName || null,
      hasMedia: Boolean(m.hasMedia),
      timestamp: m.timestamp,
    })),
  });
});

// --- Perfil de contacto ---
router.get('/contacts/:jid', async (req, res) => {
  const jid = manager.normalizeJid(req.params.jid);
  if (!jid) return fail(res, 400, 'validation', 'jid inválido');
  try {
    const profile = await manager.getContactProfile(req.clientId, jid);
    if (!profile) return fail(res, 409, 'session_not_ready', 'Sin sesión conectada para consultar el perfil');
    return res.json({ profile });
  } catch (err) {
    return mapError(res, err);
  }
});

// --- Handoff (atención humana) ---
router.get('/handoff', async (req, res) => {
  try {
    return res.json({ handoffs: await handoff.listActive(req.clientId) });
  } catch (err) {
    return mapError(res, err);
  }
});

router.post('/handoff', async (req, res) => {
  const contactJid = manager.normalizeJid(req.body?.contactJid);
  if (!contactJid) return fail(res, 400, 'validation', 'contactJid es requerido');
  const session = readySessionOf(req.clientId);
  try {
    await handoff.start(req.clientId, contactJid, {
      replyJid: contactJid,
      motivo: req.body?.motivo ? String(req.body.motivo) : 'api',
      resumen: req.body?.resumen ? String(req.body.resumen) : null,
      sessionId: session?.sessionId || null,
      ttlMinutes: null,
    });
    manager.emit('handoff:started', {
      clientId: req.clientId, sessionId: session?.sessionId || null, contactJid,
      motivo: req.body?.motivo || 'api', resumen: req.body?.resumen || null,
      timestamp: new Date().toISOString(),
    });
    auditLog(null, 'api.handoff_start', 'client', String(req.clientId), { contactJid }, req).catch(() => {});
    return res.status(201).json({ ok: true, contactJid });
  } catch (err) {
    return mapError(res, err);
  }
});

router.post('/handoff/resume', async (req, res) => {
  const contactJid = manager.normalizeJid(req.body?.contactJid);
  if (!contactJid) return fail(res, 400, 'validation', 'contactJid es requerido');
  try {
    const ok = await handoff.resume(req.clientId, contactJid);
    manager.emit('handoff:resumed', {
      clientId: req.clientId, contactJid, timestamp: new Date().toISOString(),
    });
    auditLog(null, 'api.handoff_resume', 'client', String(req.clientId), { contactJid }, req).catch(() => {});
    return res.json({ ok });
  } catch (err) {
    return mapError(res, err);
  }
});

// --- Grupos ---
router.post('/groups', async (req, res) => {
  const session = readySessionOf(req.clientId);
  if (!session) return fail(res, 409, 'session_not_ready', 'La sesión de WhatsApp del cliente no está conectada');
  try {
    const result = await manager.createGroup(
      session.sessionId,
      String(req.body?.subject || '').trim(),
      Array.isArray(req.body?.participants) ? req.body.participants : [],
    );
    auditLog(null, 'api.group_create', 'client', String(req.clientId),
      { subject: result.subject, participants: result.participants }, req).catch(() => {});
    return res.status(201).json(result);
  } catch (err) {
    return mapError(res, err);
  }
});

router.post('/groups/join', async (req, res) => {
  const session = readySessionOf(req.clientId);
  if (!session) return fail(res, 409, 'session_not_ready', 'La sesión de WhatsApp del cliente no está conectada');
  try {
    const result = await manager.joinGroupByInvite(session.sessionId, String(req.body?.invite || ''));
    auditLog(null, 'api.group_join', 'client', String(req.clientId), { groupId: result.id }, req).catch(() => {});
    return res.json(result);
  } catch (err) {
    return mapError(res, err);
  }
});

// --- Whitelist (lista blanca activable) ---
router.get('/whitelist', async (req, res) => {
  try {
    return res.json(await whitelist.getState(req.clientId));
  } catch (err) {
    return mapError(res, err);
  }
});

router.put('/whitelist', async (req, res) => {
  try {
    const state = await whitelist.setEnabled(req.clientId, req.body?.enabled === true);
    auditLog(null, 'api.whitelist_toggle', 'client', String(req.clientId),
      { enabled: req.body?.enabled === true }, req).catch(() => {});
    return res.json(state);
  } catch (err) {
    return mapError(res, err);
  }
});

router.post('/whitelist', async (req, res) => {
  const jid = manager.normalizeJid(req.body?.number || req.body?.contactJid);
  if (!jid) return fail(res, 400, 'validation', 'number es requerido (formato internacional)');
  try {
    const state = await whitelist.add(req.clientId, jid, req.body?.note);
    auditLog(null, 'api.whitelist_add', 'client', String(req.clientId), { number: jid.split('@')[0] }, req).catch(() => {});
    return res.status(201).json(state);
  } catch (err) {
    return mapError(res, err);
  }
});

router.delete('/whitelist/:number', async (req, res) => {
  const jid = manager.normalizeJid(req.params.number);
  if (!jid) return fail(res, 400, 'validation', 'number invalido');
  try {
    return res.json(await whitelist.remove(req.clientId, jid));
  } catch (err) {
    return mapError(res, err);
  }
});

// --- Stats diarias (solo contadores) ---
router.get('/stats/daily', async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 90);
  try {
    const [rows] = await pool.execute(
      `SELECT DATE_FORMAT(day, '%Y-%m-%d') AS day, msgs_in, msgs_out
       FROM daily_stats
       WHERE client_id = ? AND day >= CURDATE() - INTERVAL ? DAY
       ORDER BY day`,
      [req.clientId, days - 1],
    );
    return res.json({
      days: rows.map((r) => ({ day: r.day, in: Number(r.msgs_in), out: Number(r.msgs_out) })),
    });
  } catch (err) {
    return mapError(res, err);
  }
});

module.exports = router;
