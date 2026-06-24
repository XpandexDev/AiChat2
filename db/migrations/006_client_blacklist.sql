-- Phase 6: blacklist por contacto. Números a los que el bot NUNCA responde
-- (silencio total: no reenvía a n8n ni envía aviso). La gestionan el cliente
-- (su panel) y el admin (detalle de cliente). Permanente, no conversacional
-- (distinta del handoff_state, que es temporal y con rearme).
CREATE TABLE IF NOT EXISTS client_blacklist (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_id INT NOT NULL,
  contact_jid VARCHAR(128) NOT NULL,
  note VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_client_blacklist (client_id, contact_jid),
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  INDEX idx_client_blacklist_client (client_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
