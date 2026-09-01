-- API pública v1: una API key por cliente. Solo se guarda el hash (sha256) y
-- un prefijo para mostrar en el panel; la key completa se enseña UNA vez.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS api_key_hash CHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS api_key_prefix VARCHAR(16) NULL,
  ADD COLUMN IF NOT EXISTS api_key_created_at TIMESTAMP NULL DEFAULT NULL;

ALTER TABLE clients
  ADD INDEX IF NOT EXISTS idx_clients_api_key_hash (api_key_hash);
