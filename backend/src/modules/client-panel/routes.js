const express = require('express');
const panelService = require('./service');
const clientsService = require('../clients/service');
const sessionsManager = require('../sessions/manager');
const blacklist = require('../blacklist/service');
const whitelist = require('../whitelist/service');
const handoff = require('../handoff/service');
const { requireClient } = require('../../middleware/client-auth');
const { auditLog } = require('../../middleware/audit');
const { invalidateApiKeyCache } = require('../../middleware/api-key');
const { invalidateEventsConfig } = require('../events/dispatcher');
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

// --- Whitelist (lista blanca activable) del propio cliente ---
router.get('/whitelist', async (req, res) => {
  try {
    return res.json(await whitelist.getState(req.clientId));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.patch('/whitelist', async (req, res) => {
  const enabled = req.body?.enabled === true || req.body?.enabled === 'true';
  try {
    const state = await whitelist.setEnabled(req.clientId, enabled);
    auditLog(null, 'panel.whitelist_toggle', 'client', String(req.clientId), { enabled }, req).catch(() => {});
    return res.json(state);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/whitelist', async (req, res) => {
  const jid = sessionsManager.normalizeJid(req.body?.number);
  if (!jid) return res.status(400).json({ error: 'Numero invalido. Usa formato internacional, p.ej. 34600111222' });
  try {
    const state = await whitelist.add(req.clientId, jid, req.body?.note);
    auditLog(null, 'panel.whitelist_add', 'client', String(req.clientId), { number: jid.split('@')[0] }, req).catch(() => {});
    return res.json(state);
  } catch (error) {
    if (error.code === 'VALIDATION') return res.status(400).json({ error: error.message });
    return res.status(500).json({ error: error.message });
  }
});

router.delete('/whitelist', async (req, res) => {
  const jid = sessionsManager.normalizeJid(req.query?.number || req.body?.number);
  if (!jid) return res.status(400).json({ error: 'Numero invalido' });
  try {
    const state = await whitelist.remove(req.clientId, jid);
    auditLog(null, 'panel.whitelist_remove', 'client', String(req.clientId), { number: jid.split('@')[0] }, req).catch(() => {});
    return res.json(state);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// --- Ajustes: API keys del propio cliente (varias, self-service) ---
router.get('/api-keys', async (req, res) => {
  try {
    return res.json(await clientsService.listApiKeys(req.clientId));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/api-keys', async (req, res) => {
  try {
    const result = await clientsService.createApiKey(req.clientId, req.body?.name);
    invalidateApiKeyCache();
    auditLog(null, 'panel.api_key_generate', 'client', String(req.clientId), { name: result.name }, req).catch(() => {});
    return res.status(201).json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.delete('/api-keys/:keyId', async (req, res) => {
  try {
    const ok = await clientsService.deleteApiKey(req.clientId, Number(req.params.keyId));
    if (!ok) return res.status(404).json({ error: 'Key no encontrada' });
    invalidateApiKeyCache();
    auditLog(null, 'panel.api_key_revoke', 'client', String(req.clientId), { keyId: Number(req.params.keyId) }, req).catch(() => {});
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// --- Ajustes: webhook de EVENTOS del propio cliente ---
router.get('/events-webhook', async (req, res) => {
  try {
    const cfg = await clientsService.getEventsWebhook(req.clientId);
    return res.json({ url: cfg?.url || null, secret: cfg?.secret || null });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.put('/events-webhook', async (req, res) => {
  const url = req.body?.url != null ? String(req.body.url).trim() : '';
  if (url && !/^https?:\/\//.test(url)) {
    return res.status(400).json({ error: 'URL inválida (http/https) — o vacía para desactivar' });
  }
  try {
    const cfg = await clientsService.setEventsWebhook(req.clientId, url, req.body?.regenerateSecret === true);
    invalidateEventsConfig(req.clientId);
    auditLog(null, 'panel.events_webhook_update', 'client', String(req.clientId), { configured: Boolean(cfg.url) }, req).catch(() => {});
    return res.json(cfg);
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
