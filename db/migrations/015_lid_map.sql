-- Mapa @lid -> telefono, PERSISTENTE.
-- WhatsApp puede direccionar un 1:1 por @lid en lugar de por telefono. Ese mapeo
-- solo se aprende cuando llega un mensaje que trae `senderPn`, y hasta ahora
-- vivia unicamente en RAM: cada reinicio lo vaciaba. Con el mapa vacio, un
-- mensaje que llegue por @lid NO casa con handoff/listas (que se guardan por
-- telefono) y el bot responde a un contacto que deberia estar en manos de una
-- persona. Guardarlo en BD hace que la identidad sobreviva a los despliegues.
CREATE TABLE IF NOT EXISTS wa_lid_map (
  lid_jid VARCHAR(128) NOT NULL PRIMARY KEY,
  phone_jid VARCHAR(128) NOT NULL,
  client_id INT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_wa_lid_map_phone (phone_jid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
