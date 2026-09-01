const express = require('express');
const panelService = require('./service');
const clientsService = require('../clients/service');
const sessionsManager = require('../sessions/manager');
const blacklist = require('../blacklist/service');
const handoff = require('../handoff/service');
const { requireClient } = require('../../middleware/client-auth');
const { auditLog } = require('../../middleware/audit');
const { invalidateApiKeyCache } = require('../../middleware/api-key');
const clientAuthService = require('../client-auth/service');
const { CLIENT_COOKIE_NAME } = require('../../middleware/client-auth');
const { hashToken } = require('../../lib/session-tokens');

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
        apiKeyPrefix: client.apiKeyPrefix,
        apiKeyCreatedAt: client.apiKeyCreatedAt,
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
    auditLog(null, 'panel.bot_toggle', 'client', String(req.clientId), { enabled }, req).catch(() => {});
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
    auditLog(null, 'panel.schedule_update', 'client', String(req.clientId), {
      scheduleEnabled: Boolean(req.body?.scheduleEnabled),
      windows: Array.isArray(req.body?.windows) ? req.body.windows.length : 0,
    }, req).catch(() => {});
    return res.json(result);
  } catch (error) {
    if (error.code === 'VALIDATION') return res.status(400).json({ error: error.message });
    return res.status(500).json({ error: error.message });
  }
});

// --- Ajustes: API key del propio cliente (self-service) ---
router.post('/api-key', async (req, res) => {
  try {
    const result = await clientsService.generateApiKey(req.clientId);
    if (!result) return res.status(404).json({ error: 'Cliente no encontrado' });
    invalidateApiKeyCache();
    auditLog(null, 'panel.api_key_generate', 'client', String(req.clientId), {}, req).catch(() => {});
    // La key en claro SOLO viaja en esta respuesta.
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.delete('/api-key', async (req, res) => {
  try {
    await clientsService.revokeApiKey(req.clientId);
    invalidateApiKeyCache();
    auditLog(null, 'panel.api_key_revoke', 'client', String(req.clientId), {}, req).catch(() => {});
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// --- Ajustes: cambio de contraseña por el propio cliente ---
router.post('/password', async (req, res) => {
  const current = String(req.body?.currentPassword || '');
  const next = String(req.body?.newPassword || '');
  try {
    const keepHash = req.cookies?.[CLIENT_COOKIE_NAME]
      ? hashToken(req.cookies[CLIENT_COOKIE_NAME])
      : null;
    await clientAuthService.changePassword(req.clientId, current, next, keepHash);
    auditLog(null, 'panel.password_change', 'client', String(req.clientId), {}, req).catch(() => {});
    return res.json({ ok: true });
  } catch (error) {
    if (error.code === 'INVALID_CREDENTIALS') return res.status(401).json({ error: error.message });
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
    const list = await blacklist.add(req.clientId, jid, req.body?.note);
    auditLog(null, 'panel.blacklist_add', 'client', String(req.clientId), { number: jid.split('@')[0] }, req).catch(() => {});
    return res.json(list);
  } catch (error) {
    if (error.code === 'VALIDATION') return res.status(400).json({ error: error.message });
    return res.status(500).json({ error: error.message });
  }
});

router.delete('/blacklist', async (req, res) => {
  const jid = sessionsManager.normalizeJid(req.query?.number || req.body?.number);
  if (!jid) return res.status(400).json({ error: 'Número inválido' });
  try {
    const list = await blacklist.remove(req.clientId, jid);
    auditLog(null, 'panel.blacklist_remove', 'client', String(req.clientId), { number: jid.split('@')[0] }, req).catch(() => {});
    return res.json(list);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Perfil de un contacto (foto, "info", empresa) — solo del propio cliente.
router.get('/contact-profile', async (req, res) => {
  const jid = String(req.query.jid || '').trim();
  if (!jid) return res.status(400).json({ error: 'jid requerido' });
  try {
    const profile = await sessionsManager.getContactProfile(req.clientId, jid);
    return res.json({ profile });
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
    auditLog(null, 'panel.handoff_resume', 'client', String(req.clientId), { contactJid }, req).catch(() => {});
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
    auditLog(null, 'panel.reply_send', 'client', String(req.clientId), { to: to.split('@')[0], length: text.length }, req).catch(() => {});
    return res.json(result);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

module.exports = router;
