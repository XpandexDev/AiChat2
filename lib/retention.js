const pool = require('./../db/pool');

// Retención del histórico de conversaciones: los mensajes se guardan MESSAGE_
// RETENTION_DAYS días (7 por defecto) y luego se borran. Purga al arrancar y
// cada hora. Las conversaciones que se quedan sin mensajes se eliminan también,
// para que no queden cabeceras huérfanas en la lista.

const RETENTION_DAYS = Number(process.env.MESSAGE_RETENTION_DAYS) || 7;
const PURGE_INTERVAL_MS = 60 * 60 * 1000; // cada hora
const BATCH = 5000; // borrado por lotes: no bloquear la tabla

async function purgeOldMessages() {
  let removed = 0;
  try {
    // Lotes hasta que no quede nada más viejo que la ventana
    for (;;) {
      const [res] = await pool.execute(
        'DELETE FROM wa_messages WHERE created_at < (NOW() - INTERVAL ? DAY) LIMIT ?',
        [RETENTION_DAYS, BATCH],
      );
      removed += res.affectedRows;
      if (res.affectedRows < BATCH) break;
    }
    // Cabeceras sin mensajes (por retención o por conversación abandonada)
    await pool.execute(
      `DELETE c FROM wa_conversations c
       LEFT JOIN wa_messages m
         ON m.client_id = c.client_id AND m.contact_jid = c.contact_jid
       WHERE m.id IS NULL`,
    );
    if (removed > 0) {
      console.log(`retention: ${removed} mensajes purgados (> ${RETENTION_DAYS} días)`);
    }
  } catch (err) {
    console.error('retention: fallo al purgar:', err.message);
  }
  return removed;
}

function startRetentionJob() {
  purgeOldMessages().catch(() => {});
  const timer = setInterval(() => { purgeOldMessages().catch(() => {}); }, PURGE_INTERVAL_MS);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { purgeOldMessages, startRetentionJob, RETENTION_DAYS };
