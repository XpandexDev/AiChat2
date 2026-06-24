-- Phase 5: panel self-service por cliente.
-- Login email+password (el admin la asigna), bot on/off manual, horario semanal
-- con varias franjas por día, timezone por cliente y aviso automático configurable.

-- ADD COLUMN IF NOT EXISTS (MariaDB) hace el ALTER idempotente: si el fichero se
-- re-ejecuta (p.ej. un statement posterior falló y no se marcó como aplicado),
-- no peta con "Duplicate column name" ni deja el arranque en bucle de fallo.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255) NULL AFTER email,
  ADD COLUMN IF NOT EXISTS bot_enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER pairing_token,
  ADD COLUMN IF NOT EXISTS schedule_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER bot_enabled,
  ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) NOT NULL DEFAULT 'Europe/Madrid' AFTER schedule_enabled,
  ADD COLUMN IF NOT EXISTS auto_reply_text TEXT NULL AFTER timezone;

-- Sesiones del panel cliente. Espejo de admin_sessions, FK a clients.
CREATE TABLE IF NOT EXISTS client_sessions (
  token_hash CHAR(64) PRIMARY KEY,
  client_id INT NOT NULL,
  user_agent VARCHAR(500),
  ip_address VARCHAR(45),
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  INDEX idx_client_sessions_client_id (client_id),
  INDEX idx_client_sessions_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Franjas horarias semanales. weekday 0=domingo..6=sábado (alineado con Intl).
-- Reemplazo total en cada guardado (DELETE + INSERT). Varias filas por dia = varias franjas.
CREATE TABLE IF NOT EXISTS client_schedule (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_id INT NOT NULL,
  weekday TINYINT NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  INDEX idx_client_schedule_client_weekday (client_id, weekday)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
