const express = require('express');
const pool = require('../../db/pool');
const manager = require('./manager');
const handoff = require('../handoff/service');
const { requireAdmin } = require('../../middleware/auth');
const { auditLog } = require('../../middleware/audit');

const router = express.Router();

router.use(requireAdmin);

router.get('/', (req, res) => {
  // Filtro opcional ?clientId=N
  const clientId = req.query.clientId ? Number(req.query.clientId) : null;
  if (clientId) {
    manager.listSessionsByClient(clientId)
      .then((list) => res.json(list))
      .catch((err) => res.status(500).json({ error: err.message }));
    return;
  }
  res.json(manager.listSessions());
});

// --- Conversaciones ---
// Histórico persistente con ventana de retención (7 días por defecto,
// MESSAGE_RETENTION_DAYS). La purga corre cada hora (lib/retention.js).
// (Antes de /:sessionId para que "chat" no se interprete como un sessionId.)
router.get('/chat/recent', async (req, res) => {
  const clientId = req.query.clientId ? Number(req.query.clientId) : null;
  try {
    // Histórico persistente (ventana de retención). Sin clientId, todos los
    // clientes: el panel admin lo necesita para su vista global.
    if (clientId) {
      return res.json({ conversations: await manager.getConversationsWithMessages(clientId) });
    }
    const [rows] = await pool.execute('SELECT id FROM clients WHERE is_active = 1');
    const all = [];
    for (const r of rows) {
      all.push(...await manager.getConversationsWithMessages(r.id));
    }
    all.sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
    return res.json({ conversations: all });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Media de un mensaje del chat (imagen/audio/vídeo/documento), descargada bajo
// demanda de los servidores de WhatsApp (o del buffer si fue un envío nuestro).
router.get('/chat/media', async (req, res) => {
  const clientId = Number(req.query.clientId);
  const msgId = String(req.query.id || '').trim();
  if (!Number.isInteger(clientId) || clientId <= 0 || !msgId) {
    return res.status(400).json({ error: 'clientId e id son requeridos' });
  }
  try {
    const media = await manager.getChatMedia(clientId, msgId);
    if (!media) return res.status(404).json({ error: 'Media no disponible (expiró del buffer)' });
    res.set('Content-Type', media.mimetype || 'application/octet-stream');
    if (media.fileName) {
      res.set('Content-Disposition', `inline; filename="${encodeURIComponent(media.fileName)}"`);
    }
    res.set('Cache-Control', 'private, max-age=3600');
    return res.send(media.buffer);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Perfil de un contacto (foto, "info", perfil de empresa) vía la sesión Baileys
// del cliente. Cacheado en RAM; campos null si la privacidad del contacto los oculta.
router.get('/contact/profile', async (req, res) => {
  const clientId = Number(req.query.clientId);
  const jid = String(req.query.jid || '').trim();
  if (!Number.isInteger(clientId) || clientId <= 0 || !jid) {
    return res.status(400).json({ error: 'clientId y jid son requeridos' });
  }
  try {
    const profile = await manager.getContactProfile(clientId, jid);
    return res.json({ profile });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// --- Handoff a humano ---
// Contactos en modo humano, para hidratar el panel al cargar.
// (Antes de /:sessionId para que "handoff" no se interprete como un sessionId.)
router.get('/handoff', async (req, res) => {
  const clientId = req.query.clientId ? Number(req.query.clientId) : null;
  try {
    const list = await handoff.listActive(clientId);
    return res.json(list);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Devolver el control al bot para un contacto.
router.post('/contact/resume', async (req, res) => {
  const clientId = Number(req.body?.clientId);
  const contactJid = manager.normalizeJid(req.body?.contactJid);
  if (!Number.isInteger(clientId) || clientId <= 0 || !contactJid) {
    return res.status(400).json({ error: 'clientId y contactJid válidos son requeridos' });
  }
  try {
    const ok = await handoff.resume(clientId, contactJid);
    auditLog(req.adminId, 'handoff.resume', 'client', String(clientId), { contactJid }, req).catch(() => {});
    manager.emit('handoff:resumed', { clientId, contactJid, timestamp: new Date().toISOString() });
    return res.json({ ok });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/:sessionId', (req, res) => {
  const session = manager.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });
  return res.json(session);
});

router.post('/start', async (req, res) => {
  const clientId = Number(req.body?.clientId);
  const sessionId = String(req.body?.sessionId || '').trim();
  const mode = req.body?.mode === 'business' ? 'business' : 'normal';

  if (!Number.isInteger(clientId) || clientId <= 0) {
    return res.status(400).json({ error: 'clientId es requerido (entero positivo)' });
  }
  if (!sessionId) return res.status(400).json({ error: 'sessionId es requerido' });

  try {
    const session = await manager.startSession({ clientId, sessionId, mode });
    auditLog(req.adminId, 'session.start', 'wa_session', sessionId, { clientId, mode }, req).catch(() => {});
    return res.status(201).json(session);
  } catch (error) {
    if (error.code === 'VALIDATION') return res.status(400).json({ error: error.message });
    if (error.code === 'CLIENT_NOT_FOUND') return res.status(404).json({ error: error.message });
    if (error.code === 'CLIENT_INACTIVE') return res.status(409).json({ error: error.message });
    if (error.code === 'CONFLICT') return res.status(409).json({ error: error.message });
    return res.status(500).json({ error: error.message });
  }
});

// --- Grupos: crear y unirse por invitación (vía la sesión del cliente) ---
router.post('/:sessionId/groups', async (req, res) => {
  const subject = String(req.body?.subject || '').trim();
  const participants = Array.isArray(req.body?.participants) ? req.body.participants : [];
  try {
    const result = await manager.createGroup(req.params.sessionId, subject, participants);
    auditLog(req.adminId, 'group.create', 'wa_session', req.params.sessionId,
      { subject, participants: participants.length, groupId: result.id }, req).catch(() => {});
    return res.status(201).json(result);
  } catch (err) {
    if (err.code === 'VALIDATION') return res.status(400).json({ error: err.message });
    if (err.code === 'SESSION_NOT_READY') return res.status(409).json({ error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

router.post('/:sessionId/groups/join', async (req, res) => {
  const invite = String(req.body?.invite || '').trim();
  try {
    const result = await manager.joinGroupByInvite(req.params.sessionId, invite);
    auditLog(req.adminId, 'group.join', 'wa_session', req.params.sessionId,
      { groupId: result.id }, req).catch(() => {});
    return res.json(result);
  } catch (err) {
    if (err.code === 'VALIDATION') return res.status(400).json({ error: err.message });
    if (err.code === 'SESSION_NOT_READY') return res.status(409).json({ error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

router.post('/:sessionId/stop', async (req, res) => {
  const ok = await manager.stopSession(req.params.sessionId);
  if (!ok) return res.status(404).json({ error: 'Sesión no encontrada' });
  auditLog(req.adminId, 'session.stop', 'wa_session', req.params.sessionId, {}, req).catch(() => {});
  return res.json({ ok: true });
});

router.delete('/:sessionId', async (req, res) => {
  const result = await manager.deleteSession(req.params.sessionId);
  auditLog(req.adminId, 'session.delete', 'wa_session', req.params.sessionId, {}, req).catch(() => {});
  return res.json(result);
});

module.exports = router;
