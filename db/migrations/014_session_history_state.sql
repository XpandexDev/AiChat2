-- Estado del historial por sesion. WhatsApp solo envia el lote de
-- conversaciones al VINCULAR un numero (no en reconexiones), asi que el aviso
-- "sincronizando" dura segundos y desaparece. Guardamos el estado en BD para
-- que el panel pueda responder SIEMPRE: importado / sin importar / en curso.
ALTER TABLE wa_sessions
  ADD COLUMN IF NOT EXISTS history_state ENUM('none','syncing','imported') NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS history_messages INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS history_synced_at TIMESTAMP NULL DEFAULT NULL;
