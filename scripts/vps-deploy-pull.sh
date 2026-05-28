#!/usr/bin/env bash
# Script de pull + restart para VPS-Prod (151.241.216.125, aichat.xpandex.es).
# Se instala en /www/wwwroot/AiChat/scripts/vps-deploy-pull.sh y se ejecuta como
# root (vía SSH o a mano en la terminal del panel).
#
# Este VPS gestiona el backend con **systemd** (unit: aichat.service), NO con el
# sistema vhost de aaPanel. El repo es propiedad del usuario "www", así que las
# operaciones git se ejecutan como www para evitar el error "dubious ownership".
#
# Flujo:
#   1. git fetch + reset --hard origin/deploy  (como www)
#   2. npm install --omit=dev solo si cambió package.json  (como www)
#   3. Borrar resumer.lock huérfano
#   4. systemctl restart aichat  (como root)
#   5. Verificar: servicio activo + /api/health + tail del journal

set -euo pipefail

APP_DIR="/www/wwwroot/AiChat"
DEPLOY_BRANCH="deploy"
SERVICE_NAME="aichat"
APP_USER="www"
NPM_BIN="/www/server/nodejs/v24.15.0/bin/npm"

echo "==> [vps-deploy-pull] $(date -u +%FT%TZ)"

if [ "$(id -u)" -ne 0 ]; then
  echo "!! Debe ejecutarse como root (necesita systemctl restart)." >&2
  exit 1
fi

cd "$APP_DIR"

# Derivar AUTH_DATA_PATH del .env: localizar el resumer.lock real y avisar si las
# credenciales viven dentro del repo (un git reset/clean las borraría → todos los
# clientes tendrían que re-escanear el QR).
AUTH_DATA_PATH=$(grep -E '^AUTH_DATA_PATH=' .env 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" || echo "")
PORT=$(grep -E '^PORT=' .env 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" || echo "3000")
if [ -z "$AUTH_DATA_PATH" ]; then
  echo "!! AVISO: AUTH_DATA_PATH no está en $APP_DIR/.env." >&2
  AUTH_DATA_PATH="$APP_DIR/.baileys_auth_data"
fi
case "$AUTH_DATA_PATH" in
  "$APP_DIR"/*|"$APP_DIR")
    echo "!! AVISO CRÍTICO: AUTH_DATA_PATH ($AUTH_DATA_PATH) está dentro del dir de deploy." >&2
    echo "!! Muévelo fuera para que ningún git reset/clean borre las sesiones." >&2
    ;;
esac
LOCK_FILE="$AUTH_DATA_PATH/resumer.lock"

echo "==> git fetch + reset a origin/$DEPLOY_BRANCH (como $APP_USER)"
PRE_HASH_PKG=$(sha256sum package.json 2>/dev/null | awk '{print $1}' || echo "")
sudo -u "$APP_USER" git -C "$APP_DIR" fetch origin "$DEPLOY_BRANCH"
sudo -u "$APP_USER" git -C "$APP_DIR" reset --hard "origin/$DEPLOY_BRANCH"
POST_HASH_PKG=$(sha256sum package.json 2>/dev/null | awk '{print $1}' || echo "")

if [ "$PRE_HASH_PKG" != "$POST_HASH_PKG" ]; then
  echo "==> package.json cambió → npm install --omit=dev (como $APP_USER)"
  sudo -u "$APP_USER" "$NPM_BIN" --prefix "$APP_DIR" install --omit=dev --no-audit --no-fund
else
  echo "==> package.json sin cambios, omito npm install"
fi

echo "==> Limpiando resumer.lock si quedó huérfano"
rm -f "$LOCK_FILE"

echo "==> Reiniciando servicio systemd: $SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

echo "==> Esperando a que arranque…"
sleep 3
systemctl is-active --quiet "$SERVICE_NAME" \
  && echo "==> $SERVICE_NAME ACTIVO" \
  || { echo "!! $SERVICE_NAME NO está activo tras el restart"; systemctl status "$SERVICE_NAME" --no-pager -l | head -20; exit 1; }

echo "==> Health check (puerto $PORT)"
for i in 1 2 3 4 5; do
  if curl -fsS "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
    echo "==> /api/health OK"
    break
  fi
  echo "   …reintento $i"
  sleep 2
done

echo "==> Últimas líneas del journal:"
journalctl -u "$SERVICE_NAME" -n 20 --no-pager 2>/dev/null || echo "(journal no accesible)"
echo "==> Done."
