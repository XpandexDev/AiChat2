const express = require('express');
const manager = require('./manager');
const { requireAdmin } = require('../../middleware/auth');
const { auditLog } = require('../../middleware/audit');

const router = express.Router();

router.post('/send', requireAdmin, async (req, res) => {
  const sessionId = String(req.body?.sessionId || '').trim();
  const to = String(req.body?.to || '').trim();
  const text = String(req.body?.text || '').trim();

  if (!sessionId || !to || !text) {
    return res.status(400).json({ error: 'sessionId, to y text son requeridos' });
  }

  try {
    const result = await manager.sendMessage(sessionId, to, text);
    auditLog(req.adminId, 'message.send', 'wa_session', sessionId, { to, length: text.length }, req).catch(() => {});
    return res.json(result);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// Envío de un ADJUNTO desde el composer del panel (base64). La app lo convierte
// en imagen/vídeo/audio/documento según el mimetype. Máx. 16MB.
router.post('/send-media', requireAdmin, async (req, res) => {
  const sessionId = String(req.body?.sessionId || '').trim();
  const to = String(req.body?.to || '').trim();
  const { dataBase64, mimetype, fileName, caption } = req.body || {};

  if (!sessionId || !to || !dataBase64) {
    return res.status(400).json({ error: 'sessionId, to y dataBase64 son requeridos' });
  }

  try {
    const result = await manager.sendMediaMessage(sessionId, to, {
      dataBase64, mimetype, fileName, caption,
    });
    auditLog(req.adminId, 'message.send', 'wa_session', sessionId,
      { to, media: true, fileName: fileName || null }, req).catch(() => {});
    return res.json(result);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

module.exports = router;
