-- Whitelist por cliente: cuando esta ACTIVADA, el bot solo responde a los
-- numeros de esta lista (modo pruebas / bots restringidos). Desactivada = el
-- bot responde a todos (comportamiento normal). La blacklist SIEMPRE manda.
CREATE TABLE IF NOT EXISTS client_whitelist (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_id INT NOT NULL,
  contact_jid VARCHAR(128) NOT NULL,
  note VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_client_whitelist (client_id, contact_jid),
  CONSTRAINT fk_client_whitelist_client FOREIGN KEY (client_id)
    REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS whitelist_enabled TINYINT(1) NOT NULL DEFAULT 0;
