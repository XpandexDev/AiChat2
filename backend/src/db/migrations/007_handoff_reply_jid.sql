-- Phase 7: handoff/blacklist por TELÉFONO, no por LID.
-- WhatsApp puede direccionar por @lid (Linked ID), que NO es el número. Baileys
-- expone msg.key.senderPn = el teléfono real. A partir de ahora contact_jid guarda
-- la identidad por teléfono (para casar y mostrar) y reply_jid el JID EXACTO al que
-- responder (lo que mandó WhatsApp), para no arriesgar la entrega del mensaje.
ALTER TABLE handoff_state
  ADD COLUMN IF NOT EXISTS reply_jid VARCHAR(128) NULL AFTER contact_jid;
