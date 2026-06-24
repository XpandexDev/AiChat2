# Despliegue (VPS aaPanel + Node.js)

Este repo compila frontend + backend en la rama `deploy`. El runtime de
producción corre en un **VPS con aaPanel** (`aichat.xpandex.es`), gestionado por
el Node.js manager de aaPanel (PID file + startup script). **No** es Hostinger
ni usa Puppeteer/Chrome: la integración de WhatsApp es **Baileys**
(`@whiskeysockets/baileys`), que habla el protocolo directamente.

## Flujo de deploy

1. En local: `scripts/deploy-branch.sh --remote` compila el frontend, sincroniza
   la rama `deploy` y dispara el pull remoto por SSH.
2. En el VPS, `scripts/vps-deploy-pull.sh`:
   - `git reset --hard origin/deploy` (la rama `deploy` es el runtime).
   - `npm install --omit=dev` solo si cambió `package.json`.
   - Mata el proceso Node anterior y relanza vía el startup script de aaPanel.

## Variables de entorno (en el `.env` del VPS, NO versionado)

Ver `backend/.env.production.example`. Las requeridas:
`PORT`, `CORS_ORIGIN`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`,
`DB_NAME`, `SESSION_SECRET`. Opcionales: `WEBHOOK_INCOMING_URL`,
`WEBHOOK_SECRET`, `AUTH_DATA_PATH`.

## CRÍTICO: persistencia de sesiones de WhatsApp

Las credenciales de cada sesión viven en `AUTH_DATA_PATH/session-<id>/`. Si esa
ruta cambia o se borra, **todos los clientes pierden la vinculación y tienen que
re-escanear el QR**. Reglas:

- `AUTH_DATA_PATH` debe ser una ruta **absoluta** y **fuera del directorio de
  deploy** (`/www/wwwroot/AiChat`). Recomendado:
  `/www/wwwroot/AiChat-data/baileys_auth`. Así ningún `git reset --hard` /
  `git clean` del deploy puede tocarla.
- **Un solo proceso/instancia Node.** Baileys no admite dos conexiones con las
  mismas credenciales: dos workers provocan `connectionReplaced` en bucle y
  corrupción de los contadores de Signal Protocol. Mantener 1 instancia en
  aaPanel.
- El proceso reanuda solo las sesiones al arrancar (`resumeSessions`), reconecta
  con backoff exponencial y tolera arranques con MySQL aún no disponible.

### Migrar el directorio de auth a la ruta segura (una sola vez)

Si hoy las credenciales están dentro de `/www/wwwroot/AiChat`, muévelas con el
proceso parado:

```bash
systemctl stop <servicio-node>   # o parar vía aaPanel
mkdir -p /www/wwwroot/AiChat-data
mv /www/wwwroot/AiChat/.baileys_auth_data /www/wwwroot/AiChat-data/baileys_auth
# Editar el .env: AUTH_DATA_PATH=/www/wwwroot/AiChat-data/baileys_auth
chown -R www:www /www/wwwroot/AiChat-data   # mismo usuario que corre el Node
# Relanzar vía aaPanel
```

## Servicios

- API en `/api`, frontend estático servido por el mismo Node, Socket.IO en
  `/socket.io` (panel admin en tiempo real; el onboarding del cliente usa polling).
