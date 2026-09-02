-- Historico de conversaciones con RETENCION DE 7 DIAS.
-- Cambia la decision previa de "solo en vivo": ahora el contenido de los
-- mensajes SI se persiste, pero se purga automaticamente pasada una semana
-- (purga horaria en el arranque del servicio, ver lib/retention.js).
CREATE TABLE IF NOT EXISTS wa_messages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  client_id INT NOT NULL,
  contact_jid VARCHAR(128) NOT NULL,
  direction ENUM('in','out') NOT NULL,
  wa_message_id VARCHAR(128) NULL,
  body TEXT NULL,
  sender_name VARCHAR(190) NULL,
  participant VARCHAR(128) NULL,
  is_group TINYINT(1) NOT NULL DEFAULT 0,
  has_media TINYINT(1) NOT NULL DEFAULT 0,
  msg_type VARCHAR(60) NULL,
  file_name VARCHAR(255) NULL,
  source VARCHAR(40) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_wa_messages_thread (client_id, contact_jid, created_at),
  KEY idx_wa_messages_purge (created_at),
  KEY idx_wa_messages_waid (client_id, wa_message_id),
  CONSTRAINT fk_wa_messages_client FOREIGN KEY (client_id)
    REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Cabecera por conversacion: nombre/subject y ultimo mensaje, para listar
-- sin escanear wa_messages.
CREATE TABLE IF NOT EXISTS wa_conversations (
  client_id INT NOT NULL,
  contact_jid VARCHAR(128) NOT NULL,
  display_name VARCHAR(190) NULL,
  is_group TINYINT(1) NOT NULL DEFAULT 0,
  last_at TIMESTAMP(3) NULL DEFAULT NULL,
  last_body TEXT NULL,
  PRIMARY KEY (client_id, contact_jid),
  KEY idx_wa_conversations_recent (client_id, last_at),
  CONSTRAINT fk_wa_conversations_client FOREIGN KEY (client_id)
    REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
