const express = require('express');
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

// --- Chat en vivo ---
// Conversaciones recientes desde el ring buffer EN RAM del manager (sin BD:
// contexto para hidratar la vista de chat al abrir; un reinicio lo vacía).
// (Antes de /:sessionId para que "chat" no se interprete como un sessionId.)
router.get('/chat/recent', (req, res) => {
  const clientId = req.query.clientId ? Number(req.query.clientId) : null;
  try {
    return res.json({ conversations: manager.getRecentConversations(clientId) });
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
