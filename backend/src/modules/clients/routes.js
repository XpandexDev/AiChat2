const express = require('express');
const clientsService = require('./service');
const sessionsManager = require('../sessions/manager');
const blacklist = require('../blacklist/service');
const { requireAdmin } = require('../../middleware/auth');
const { auditLog } = require('../../middleware/audit');
const { invalidateApiKeyCache } = require('../../middleware/api-key');
const { invalidateEventsConfig } = require('../events/dispatcher');

const router = express.Router();

router.use(requireAdmin);

router.get('/', async (req, res) => {
  try {
    const activeOnly = req.query.active === '1' || req.query.active === 'true';
    const list = await clientsService.listClients({ activeOnly });
    return res.json(list);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  try {
    const client = await clientsService.getClient(id);
    if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
    return res.json(client);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const client = await clientsService.createClient(req.body || {}, req.adminId);
    auditLog(req.adminId, 'client.create', 'client', String(client.id), { name: client.name }, req).catch(() => {});
    return res.status(201).json(client);
  } catch (error) {
    if (error.code === 'VALIDATION') return res.status(400).json({ error: error.message });
    return res.status(500).json({ error: error.message });
  }
});

router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  try {
    const updated = await clientsService.updateClient(id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Cliente no encontrado' });
    auditLog(req.adminId, 'client.update', 'client', String(id), { fields: Object.keys(req.body || {}) }, req).catch(() => {});
    return res.json(updated);
  } catch (error) {
    if (error.code === 'VALIDATION') return res.status(400).json({ error: error.message });
    return res.status(500).json({ error: error.message });
  }
});

router.post('/:id/pairing/regenerate', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  try {
    const updated = await clientsService.regeneratePairingToken(id);
    if (!updated) return res.status(404).json({ error: 'Cliente no encontrado' });
    auditLog(req.adminId, 'client.pairing_regenerate', 'client', String(id), {}, req).catch(() => {});
    return res.json(updated);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Asignar/resetear la contraseña del panel del cliente (admin la define).
router.post('/:id/password', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const password = String(req.body?.password || '');
  try {
    const updated = await clientsService.setClientPassword(id, password);
    if (!updated) return res.status(404).json({ error: 'Cliente no encontrado' });
    // Nunca registrar la contraseña en el audit log.
    auditLog(req.adminId, 'client.set_password', 'client', String(id), {}, req).catch(() => {});
    return res.json({ ok: true, passwordConfigured: updated.passwordConfigured });
  } catch (error) {
    if (error.code === 'VALIDATION') return res.status(400).json({ error: error.message });
    return res.status(500).json({ error: error.message });
  }
});

// --- API keys del cliente (varias, con nombre) ---
router.get('/:id/api-keys', async (req, res) => {
  try {
    return res.json(await clientsService.listApiKeys(Number(req.params.id)));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/:id/api-keys', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const result = await clientsService.createApiKey(id, req.body?.name);
    invalidateApiKeyCache();
    auditLog(req.adminId, 'client.api_key_generate', 'client', String(id), { name: result.name }, req).catch(() => {});
    // La key en claro SOLO viaja en esta respuesta; no se vuelve a mostrar.
    return res.status(201).json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.delete('/:id/api-keys/:keyId', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const ok = await clientsService.deleteApiKey(id, Number(req.params.keyId));
    if (!ok) return res.status(404).json({ error: 'Key no encontrada' });
    invalidateApiKeyCache();
    auditLog(req.adminId, 'client.api_key_revoke', 'client', String(id), { keyId: Number(req.params.keyId) }, req).catch(() => {});
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// --- Webhook de EVENTOS del cliente ---
router.put('/:id/events-webhook', async (req, res) => {
  const id = Number(req.params.id);
  const url = req.body?.url != null ? String(req.body.url).trim() : '';
  if (url && !/^https?:\/\//.test(url)) {
    return res.status(400).json({ error: 'URL inválida (http/https) — o vacía para desactivar' });
  }
  try {
    const cfg = await clientsService.setEventsWebhook(id, url, req.body?.regenerateSecret === true);
    invalidateEventsConfig(id);
    auditLog(req.adminId, 'client.events_webhook_update', 'client', String(id), { configured: Boolean(cfg.url) }, req).catch(() => {});
    return res.json(cfg);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });

  try {
    // Antes de borrar: tirar las sesiones del cliente (memoria + disco) para no dejar basura.
    // La cascada DB se encarga de los rows de wa_sessions.
    const dropped = await sessionsManager.dropSessionsForClient(id);

    const ok = await clientsService.deleteClient(id);
    if (!ok) return res.status(404).json({ error: 'Cliente no encontrado' });

    auditLog(req.adminId, 'client.delete', 'client', String(id), { sessionsDropped: dropped }, req).catch(() => {});
    return res.json({ ok: true, sessionsDropped: dropped });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// --- Blacklist (números sin bot) de un cliente, gestionada por el admin ---
router.get('/:id/blacklist', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  try {
    return res.json(await blacklist.list(id));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/:id/blacklist', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const jid = sessionsManager.normalizeJid(req.body?.number);
  if (!jid) return res.status(400).json({ error: 'Número inválido. Usa formato internacional, p.ej. 34600111222' });
  try {
    const list = await blacklist.add(id, jid, req.body?.note);
    auditLog(req.adminId, 'client.blacklist_add', 'client', String(id), { number: jid }, req).catch(() => {});
    return res.json(list);
  } catch (error) {
    if (error.code === 'VALIDATION') return res.status(400).json({ error: error.message });
    return res.status(500).json({ error: error.message });
  }
});

router.delete('/:id/blacklist', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const jid = sessionsManager.normalizeJid(req.query?.number || req.body?.number);
  if (!jid) return res.status(400).json({ error: 'Número inválido' });
  try {
    const list = await blacklist.remove(id, jid);
    auditLog(req.adminId, 'client.blacklist_remove', 'client', String(id), { number: jid }, req).catch(() => {});
    return res.json(list);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Conveniencia: listar sesiones de un cliente. La gestión de sesiones sigue
// viviendo en /api/sessions (con clientId en el body al crear), pero esta
// ruta facilita la vista por cliente al frontend.
router.get('/:id/sessions', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  try {
    const client = await clientsService.getClient(id);
    if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
    const sessions = await sessionsManager.listSessionsByClient(id);
    return res.json(sessions);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
