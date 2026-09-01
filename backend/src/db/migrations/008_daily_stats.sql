-- Contadores diarios de mensajes por cliente (SOLO números, nunca contenido —
-- la decisión de no persistir conversaciones sigue en pie). Alimenta el
-- dashboard de inicio del admin.
CREATE TABLE IF NOT EXISTS daily_stats (
  client_id INT NOT NULL,
  day DATE NOT NULL,
  msgs_in INT NOT NULL DEFAULT 0,
  msgs_out INT NOT NULL DEFAULT 0,
  PRIMARY KEY (client_id, day),
  CONSTRAINT fk_daily_stats_client FOREIGN KEY (client_id)
    REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
