-- API v1.1: multiples API keys con nombre por cliente (rotacion sin downtime,
-- last_used visible) + webhook de EVENTOS salientes por cliente.
CREATE TABLE IF NOT EXISTS client_api_keys (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_id INT NOT NULL,
  name VARCHAR(80) NOT NULL,
  key_hash CHAR(64) NOT NULL,
  key_prefix VARCHAR(16) NOT NULL,
  last_used_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_client_api_keys_hash (key_hash),
  KEY idx_client_api_keys_client (client_id),
  CONSTRAINT fk_client_api_keys_client FOREIGN KEY (client_id)
    REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Migrar la key legacy (columna unica en clients) a la tabla, si existia
INSERT IGNORE INTO client_api_keys (client_id, name, key_hash, key_prefix, created_at)
  SELECT id, 'default', api_key_hash, COALESCE(api_key_prefix, ''), COALESCE(api_key_created_at, NOW())
  FROM clients WHERE api_key_hash IS NOT NULL;

-- Webhook de eventos salientes (message.received, handoff.started, ...)
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS events_webhook_url VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS events_webhook_secret VARCHAR(128) NULL;
