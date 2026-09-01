const express = require('express');
const pool = require('../../db/pool');
const manager = require('../sessions/manager');
const handoff = require('../handoff/service');
const { requireAdmin } = require('../../middleware/auth');

const router = express.Router();

router.use(requireAdmin);

// Vista de conjunto para el dashboard de inicio del admin.
// Números de daily_stats (solo contadores) + estado vivo del manager.
router.get('/overview', async (_req, res) => {
  try {
    const sessions = manager.listSessions();
    const handoffs = await handoff.listActive(null);

    const [[today]] = await pool.execute(
      `SELECT COALESCE(SUM(msgs_in),0) AS msgs_in, COALESCE(SUM(msgs_out),0) AS msgs_out
       FROM daily_stats WHERE day = CURDATE()`,
    );

    const [series] = await pool.execute(
      `SELECT DATE_FORMAT(day, '%Y-%m-%d') AS day,
              COALESCE(SUM(msgs_in),0) AS msgs_in, COALESCE(SUM(msgs_out),0) AS msgs_out
       FROM daily_stats
       WHERE day >= CURDATE() - INTERVAL 13 DAY
       GROUP BY day ORDER BY day`,
    );

    const [byClient] = await pool.execute(
      `SELECT ds.client_id AS clientId, c.name,
              COALESCE(SUM(ds.msgs_in),0) AS msgs_in, COALESCE(SUM(ds.msgs_out),0) AS msgs_out
       FROM daily_stats ds
       JOIN clients c ON c.id = ds.client_id
       WHERE ds.day >= CURDATE() - INTERVAL 13 DAY
       GROUP BY ds.client_id, c.name
       ORDER BY (SUM(ds.msgs_in) + SUM(ds.msgs_out)) DESC
       LIMIT 10`,
    );

    // Conversaciones con actividad hoy (del buffer RAM del chat)
    const todayPrefix = new Date().toISOString().slice(0, 10);
    const activeConversations = manager.getRecentConversations()
      .filter((c) => String(c.lastAt || '').startsWith(todayPrefix)).length;

    return res.json({
      sessions: {
        total: sessions.length,
        ready: sessions.filter((s) => s.status === 'ready').length,
      },
      handoffs: handoffs.length,
      activeConversations,
      today: { in: Number(today.msgs_in), out: Number(today.msgs_out) },
      series: series.map((r) => ({ day: r.day, in: Number(r.msgs_in), out: Number(r.msgs_out) })),
      byClient: byClient.map((r) => ({
        clientId: r.clientId, name: r.name, in: Number(r.msgs_in), out: Number(r.msgs_out),
      })),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
