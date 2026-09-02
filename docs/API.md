# AiChat API v1 — Guía de inicio rápido

API REST de la plataforma de chatbots de WhatsApp. Cada **API key** pertenece a un
cliente y accede **solo a sus datos**.

- **Base URL**: `https://aichat.xpandex.es/api/v1`
- **Docs interactivas** (probar llamadas desde el navegador): `https://aichat.xpandex.es/api/docs`
- **Especificación OpenAPI**: `https://aichat.xpandex.es/api/v1/openapi.json`

## Autenticación

La key se genera desde el panel de administración (ficha del cliente → pestaña
**Integración** → "Generar key") y **se muestra una sola vez**. Envíala en cada
petición:

```
Authorization: Bearer xpk_xxxxxxxxxxxxxxxx
```

(También se acepta la cabecera `X-Api-Key`.)

## Tu primer mensaje en 3 pasos

```bash
# 1) Comprueba tu conexión
curl https://aichat.xpandex.es/api/v1/me \
  -H "Authorization: Bearer $XPK"

# 2) Envía un texto (puede INICIAR la conversación — el contacto no necesita
#    haber escrito antes). '@34600...' en el texto = mención real en grupos.
curl -X POST https://aichat.xpandex.es/api/v1/messages \
  -H "Authorization: Bearer $XPK" -H "Content-Type: application/json" \
  -d '{"to": "34600111222", "text": "Hola, te escribimos por tu pedido."}'

# 3) Envía un archivo por URL (la app valida que sea un archivo real: PDF,
#    imagen, Office, CSV, ZIP — nunca adjunta una página web)
curl -X POST https://aichat.xpandex.es/api/v1/messages \
  -H "Authorization: Bearer $XPK" -H "Content-Type: application/json" \
  -d '{"to": "34600111222", "file": {"url": "https://midominio.es/factura.pdf", "fileName": "Factura.pdf"}}'
```

## Desde n8n (nodo HTTP Request)

El caso típico: un workflow necesita **escribir primero** a alguien (p. ej.
avisar a la otra parte de un contrato).

- **Method**: POST · **URL**: `https://aichat.xpandex.es/api/v1/messages`
- **Authentication**: Generic Credential → Header Auth → Name `Authorization`,
  Value `Bearer xpk_…` (guárdala como credencial, no en el nodo)
- **Body** (JSON):
  ```json
  {
    "to": "={{ $json.telefono_b }}",
    "text": "Hola, {{ $json.nombre_a }} ha iniciado un contrato contigo. Rellena tus datos aquí:\n\n{{ $json.enlace_b }}"
  }
  ```

## Endpoints

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/me` | Identidad + estado de la conexión WhatsApp |
| POST | `/messages` | Enviar texto o archivo (URL o base64); inicia conversaciones |
| GET | `/conversations` | Conversaciones recientes |
| GET | `/conversations/{jid}/messages` | Hilo con un contacto (paginable: `limit`, `before`) |
| GET | `/contacts/{jid}` | Perfil: nombre, foto, "info", empresa |
| GET | `/handoff` | Contactos en atención humana |
| POST | `/handoff` | Pausar el bot para un contacto (`{contactJid, motivo?, resumen?}`) |
| POST | `/handoff/resume` | Devolver el contacto al bot |
| POST | `/groups` | Crear grupo (`{subject, participants[]}`) |
| POST | `/groups/join` | Unirse por enlace de invitación |
| GET | `/stats/daily?days=14` | Mensajes por día (contadores) |
| GET | `/whitelist` | Estado (activada o no) y números de la lista blanca |
| PUT | `/whitelist` | Activar/desactivar (`{enabled: true}`) |
| POST | `/whitelist` | Añadir número (`{number, note?}`) |
| DELETE | `/whitelist/{number}` | Quitar número |

Detalle completo con ejemplos de respuesta: **/api/docs**.

## Webhooks de eventos

Configura una URL de eventos (panel → Ajustes → API, o `PUT /v1/events-webhook`)
y recibirás un POST por cada evento:

`message.received` · `message.sent` · `message.delivered` · `message.read` ·
`handoff.started` · `handoff.resumed` · `session.connected` · `session.disconnected`

```json
{ "id": "uuid", "type": "message.received", "clientId": 4,
  "timestamp": "2026-09-01T10:00:00.000Z", "data": { "message": { … }, "contact": { … } } }
```

**Verifica SIEMPRE la firma** (cabecera `X-AiChat-Signature: sha256=<hex>`,
HMAC-SHA256 del body crudo con tu secret `whsec_…`):

```js
const crypto = require('crypto');
const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-aichat-signature'] || ''));
```

Reintentos si no respondes 2xx: a los 30s, 2min y 10min (best-effort; un
reinicio del servicio pierde los reintentos pendientes).

## Idempotencia

En `POST /v1/messages`, añade `Idempotency-Key: <string único>` — los reintentos
con la misma clave devuelven la respuesta original **sin reenviar** el WhatsApp
(ventana 24h; la respuesta repetida lleva `Idempotent-Replay: true`).

## Estado de entrega

`GET /v1/messages/{id}/status` → `{ status: "sent" | "delivered" | "read" }`
(ticks de WhatsApp; buffer en memoria de mensajes recientes). También llegan
como eventos `message.delivered` / `message.read` al webhook.

## API keys

Puedes tener **varias keys con nombre** (prod, n8n, test…) y ver su último uso
en el panel. Eliminar una key corta solo esa integración: rotación sin downtime
creando la nueva antes de borrar la vieja.

## Lista blanca (modo restringido)

Con la lista blanca **activada**, el bot solo responde a los números que estén en
ella — ideal para probar en producción sin atender a clientes reales. Desactivada,
el bot responde a todos.

Prioridad de las reglas sobre un mensaje entrante:
`blacklist` (silencio total) → `lista blanca` (si está activa y el número no está,
se ignora) → `handoff` → `horario/bot on-off` → el bot responde.

## Límites y comportamiento

- **Rate limit**: 120 peticiones/minuto por key → `429` con `Retry-After`.
- **Archivos**: hasta 16MB. Por URL solo tipos permitidos verificados por
  Content-Type real (PDF, JPG/PNG/WebP, DOC/DOCX, XLS/XLSX, CSV, ZIP).
- **Conversaciones**: histórico persistente con **retención de 7 días**
  (configurable con `MESSAGE_RETENTION_DAYS`). Pasada la ventana, los mensajes se
  purgan automáticamente. Si necesitas conservarlos más tiempo, guárdalos en tu
  lado (o suscríbete a los eventos `message.received` / `message.sent`).
  `GET /v1/conversations/{jid}/messages` acepta `limit` (máx. 500) y `before`
  (timestamp ISO) para paginar hacia atrás.
- **Sesión**: si el WhatsApp del cliente no está vinculado/conectado, los envíos
  devuelven `409 session_not_ready`.
- Los envíos por API aparecen en el panel del chat etiquetados como **API** y
  quedan auditados.

## Errores

Formato uniforme:

```json
{ "error": { "code": "validation", "message": "to es requerido" } }
```

| HTTP | code | Cuándo |
|---|---|---|
| 400 | `validation` | Falta un campo o es inválido (también URL de archivo no permitida) |
| 401 | `unauthorized` | Key ausente, inválida o revocada |
| 404 | `not_found` | Recurso inexistente (p. ej. conversación fuera del buffer) |
| 409 | `session_not_ready` | El WhatsApp del cliente no está conectado |
| 429 | `rate_limited` | Límite de peticiones alcanzado |
| 500 | `internal` | Error del servidor |

## Seguridad

- Trata la key como una contraseña: solo en servidores/credenciales, nunca en
  frontend ni repositorios.
- Rotación: generar una key nueva invalida la anterior al instante. Revocar
  deja al cliente sin acceso API.
