const express = require('express');
const panelService = require('./service');
const clientsService = require('../clients/service');
const sessionsManager = require('../sessions/manager');
const blacklist = require('../blacklist/service');
const handoff = require('../handoff/service');
const { requireClient } = require('../../middleware/client-auth');

const router = express.Router();

router.use(requireClient);

// Perfil + estado del bot + sus sesiones. Solo datos del propio cliente.
router.get('/me', async (req, res) => {
  try {
    const client = await clientsService.getClient(req.clientId);
    if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
    const sessions = await sessionsManager.listSessionsByClient(req.clientId);
    // Proyección: solo lo que el panel necesita (no exponer webhook/infra al cliente).
    return res.json({
      client: {
        id: client.id,
        name: client.name,
        email: client.email,
        botEnabled: client.botEnabled,
        scheduleEnabled: client.scheduleEnabled,
        timezone: client.timezone,
        autoReplyText: client.autoReplyText,
        pairingToken: client.pairingToken,
      },
      sessions: (sessions || []).map((s) => ({
        sessionId: s.sessionId,
        status: s.status,
        connectedNumber: s.connectedNumber,
      })),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.patch('/bot', async (req, res) => {
  const enabled = req.body?.enabled === true || req.body?.enabled === 'true';
  try {
    await panelService.setBotEnabled(req.clientId, enabled);
    sessionsManager.invalidateBotState(req.clientId);
    return res.json({ ok: true, botEnabled: enabled });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.get('/schedule', async (req, res) => {
  try {
    const schedule = await panelService.getScheduleSettings(req.clientId);
    return res.json(schedule);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.put('/schedule', async (req, res) => {
  try {
    const result = await panelService.replaceSchedule(req.clientId, req.body || {});
    sessionsManager.invalidateBotState(req.clientId);
    return res.json(result);
  } catch (error) {
    if (error.code === 'VALIDATION') return res.status(400).json({ error: error.message });
    return res.status(500).json({ error: error.message });
  }
});

// --- Blacklist (números sin bot) del propio cliente ---
router.get('/blacklist', async (req, res) => {
  try {
    return res.json(await blacklist.list(req.clientId));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/blacklist', async (req, res) => {
  const jid = sessionsManager.normalizeJid(req.body?.number);
  if (!jid) return res.status(400).json({ error: 'Número inválido. Usa formato internacional, p.ej. 34600111222' });
  try {
    return res.json(await blacklist.add(req.clientId, jid, req.body?.note));
  } catch (error) {
    if (error.code === 'VALIDATION') return res.status(400).json({ error: error.message });
    return res.status(500).json({ error: error.message });
  }
});

router.delete('/blacklist', async (req, res) => {
  const jid = sessionsManager.normalizeJid(req.query?.number || req.body?.number);
  if (!jid) return res.status(400).json({ error: 'Número inválido' });
  try {
    return res.json(await blacklist.remove(req.clientId, jid));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// --- Handoff (contactos con humano al mando) del propio cliente ---
router.get('/handoff', async (req, res) => {
  try {
    return res.json(await handoff.listActive(req.clientId));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/contact/resume', async (req, res) => {
  const contactJid = sessionsManager.normalizeJid(req.body?.contactJid);
  if (!contactJid) return res.status(400).json({ error: 'contactJid requerido' });
  try {
    const ok = await handoff.resume(req.clientId, contactJid);
    sessionsManager.emit('handoff:resumed', { clientId: req.clientId, contactJid, timestamp: new Date().toISOString() });
    return res.json({ ok });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Responder a un contacto desde el panel. `to` debe ser el reply_jid del handoff
// (JID exacto al que mandó WhatsApp). Verifica que la sesión es del propio cliente.
router.post('/send', async (req, res) => {
  const sessionId = String(req.body?.sessionId || '').trim();
  const to = String(req.body?.to || '').trim();
  const text = String(req.body?.text || '').trim();
  if (!sessionId || !to || !text) {
    return res.status(400).json({ error: 'sessionId, to y text son requeridos' });
  }
  try {
    const ownerId = await sessionsManager.lookupClientIdBySessionId(sessionId);
    if (ownerId !== req.clientId) {
      return res.status(403).json({ error: 'Esa sesión no es de este cliente' });
    }
    const result = await sessionsManager.sendMessage(sessionId, to, text);
    return res.json(result);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

module.exports = router;
