-- Deduplicacion del historico: el mismo mensaje puede llegar dos veces (evento
-- en vivo + lote de sincronizacion al vincular/reconectar). Un indice UNICO
-- sobre (client_id, wa_message_id) lo impide; los NULL no colisionan en MySQL.
ALTER TABLE wa_messages DROP INDEX idx_wa_messages_waid;

ALTER TABLE wa_messages
  ADD UNIQUE INDEX uq_wa_messages_waid (client_id, wa_message_id);
