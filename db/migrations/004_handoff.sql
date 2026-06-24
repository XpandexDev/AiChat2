-- Handoff a humano: estado "modo humano" por contacto y cliente.
-- Cuando el agente n8n decide ceder la conversación (handoff:true), la app marca
-- aquí al contacto en status='human' y deja de reenviar sus mensajes al bot.
-- El rearme pone status='bot' (no se borra la fila, para historial/auditoría).
CREATE TABLE IF NOT EXISTS handoff_state (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_id INT NOT NULL,
  contact_jid VARCHAR(128) NOT NULL,
  session_id VARCHAR(190) NULL,
  status ENUM('human','bot') NOT NULL DEFAULT 'human',
  motivo VARCHAR(255) NULL,
  resumen TEXT NULL,
  assigned_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  released_at TIMESTAMP NULL DEFAULT NULL,
  expires_at TIMESTAMP NULL DEFAULT NULL,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_client_contact (client_id, contact_jid),
  KEY idx_active (client_id, status),
  CONSTRAINT fk_handoff_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
