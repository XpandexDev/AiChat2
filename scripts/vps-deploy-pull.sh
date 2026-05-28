#!/usr/bin/env bash
# Script de pull + restart para VPS-Prod (151.241.216.125, aichat.xpandex.es).
# Se instala en /www/wwwroot/AiChat/scripts/vps-deploy-pull.sh y se ejecuta como
# root (vía SSH o a mano en la terminal del panel).
#
# Este VPS gestiona el backend con **systemd** (unit: aichat.service), NO con el
# sistema vhost de aaPanel. El repo es propiedad del usuario "www", así que las
# operaciones git se ejecutan como www para evitar el error "dubious ownership".
#
# GARANTÍAS de este script (lo que pidió el cliente):
#   - Las credenciales/QR NUNCA se pierden: viven fuera del working tree y, además,
#     se respalda el directorio de auth antes de cada deploy y se restaura si tras
#     el pull desaparecieran sesiones.
#   - El servicio NO se reinicia salvo que cambie el backend. Los deploys de solo
#     frontend (deploy/browser/**) no tocan el proceso → cero caída del bot.
#
# Flujo:
#   1. Backup del dir de auth (rotando los últimos N)
#   2. git fetch + reset --hard origin/deploy  (como www)
#   3. Salvaguarda: restaurar credenciales si desaparecieron tras el reset
#   4. npm install --omit=dev solo si cambió package.json  (como www)
#   5. systemctl restart aichat SOLO si cambió el backend
#   6. Verificar: servicio activo + /api/health + tail del journal

set -euo pipefail

APP_DIR="/www/wwwroot/AiChat"
DEPLOY_BRANCH="deploy"
SERVICE_NAME="aichat"
APP_USER="www"
NPM_BIN="/www/server/nodejs/v24.15.0/bin/npm"
AUTH_BACKUP_DIR="/www/wwwroot/AiChat_auth_backups"
KEEP_BACKUPS=5

echo "==> [vps-deploy-pull] $(date -u +%FT%TZ)"
[ "$(id -u)" -eq 0 ] || { echo "!! Ejecuta como root (necesita systemctl)."; exit 1; }

cd "$APP_DIR"

# --- Config derivada del .env (no versionado, sobrevive al deploy) ---
AUTH_DATA_PATH=$(grep -E '^AUTH_DATA_PATH=' .env 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d "\"'" || echo "")
PORT=$(grep -E '^PORT=' .env 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d "\"'" || echo "3000")
[ -z "$AUTH_DATA_PATH" ] && { echo "!! AUTH_DATA_PATH no está en .env"; AUTH_DATA_PATH="$APP_DIR/.baileys_auth_data"; }
case "$AUTH_DATA_PATH" in
  "$APP_DIR"/*|"$APP_DIR")
    echo "!! AVISO CRÍTICO: AUTH_DATA_PATH ($AUTH_DATA_PATH) está dentro del dir de deploy." >&2
    echo "!! Muévelo fuera para que ningún git reset/clean borre las sesiones." >&2 ;;
esac
LOCK_FILE="$AUTH_DATA_PATH/resumer.lock"

count_sessions() { find "$1" -maxdepth 1 -type d -name 'session-*' 2>/dev/null | wc -l | tr -d ' '; }

# --- 1) BACKUP del dir de auth ANTES de tocar nada ---
SESS_BEFORE=0
BACKUP_PATH=""
if [ -d "$AUTH_DATA_PATH" ]; then
  SESS_BEFORE=$(count_sessions "$AUTH_DATA_PATH")
  mkdir -p "$AUTH_BACKUP_DIR"
  BACKUP_PATH="$AUTH_BACKUP_DIR/auth-$(date +%Y%m%d-%H%M%S)"
  cp -a "$AUTH_DATA_PATH" "$BACKUP_PATH"
  echo "==> Backup credenciales: $BACKUP_PATH ($SESS_BEFORE sesiones)"
  # Rotar: conservar solo los KEEP_BACKUPS más recientes
  ls -1dt "$AUTH_BACKUP_DIR"/auth-* 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -rf
else
  echo "!! AVISO: no existe $AUTH_DATA_PATH (¿primer arranque?)"
fi

# --- 2) git fetch + reset (como www) ---
OLD_HEAD=$(sudo -u "$APP_USER" git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || echo "none")
echo "==> git fetch + reset a origin/$DEPLOY_BRANCH (como $APP_USER)"
sudo -u "$APP_USER" git -C "$APP_DIR" fetch origin "$DEPLOY_BRANCH"
sudo -u "$APP_USER" git -C "$APP_DIR" reset --hard "origin/$DEPLOY_BRANCH"
NEW_HEAD=$(sudo -u "$APP_USER" git -C "$APP_DIR" rev-parse HEAD)

# --- 3) SALVAGUARDA: restaurar credenciales si desaparecieron ---
if [ -n "$BACKUP_PATH" ]; then
  SESS_AFTER=$(count_sessions "$AUTH_DATA_PATH")
  if [ "$SESS_AFTER" -lt "$SESS_BEFORE" ]; then
    echo "!! ALERTA: sesiones $SESS_BEFORE→$SESS_AFTER tras el reset. Restaurando backup."
    mkdir -p "$AUTH_DATA_PATH"
    cp -a "$BACKUP_PATH/." "$AUTH_DATA_PATH/"
    echo "==> Restaurado. Sesiones ahora: $(count_sessions "$AUTH_DATA_PATH")"
  fi
fi

# --- 4) Decidir npm install y restart según qué cambió ---
if [ "$OLD_HEAD" = "$NEW_HEAD" ]; then
  echo "==> Sin cambios nuevos (HEAD igual). No se reinicia. Done."
  exit 0
fi

if [ "$OLD_HEAD" = "none" ]; then
  CHANGED="(repo inicial — forzar restart)"
  NEEDS_RESTART=true
  NEEDS_NPM=true
else
  CHANGED=$(sudo -u "$APP_USER" git -C "$APP_DIR" diff --name-only "$OLD_HEAD" "$NEW_HEAD" 2>/dev/null || echo "")
  echo "==> Archivos cambiados:"; echo "$CHANGED" | sed 's/^/    /'
  # Restart si hay CUALQUIER cambio fuera de deploy/ (es decir, en el backend)
  if echo "$CHANGED" | grep -qvE '^deploy/'; then NEEDS_RESTART=true; else NEEDS_RESTART=false; fi
  if echo "$CHANGED" | grep -qE '(^|/)package\.json$'; then NEEDS_NPM=true; else NEEDS_NPM=false; fi
fi

# --- 4b) npm install solo si cambió package.json ---
if [ "$NEEDS_NPM" = true ]; then
  echo "==> package.json cambió → npm install --omit=dev (como $APP_USER)"
  sudo -u "$APP_USER" env npm_config_cache=/tmp/.npm-"$APP_USER" \
    "$NPM_BIN" install --omit=dev --no-audit --no-fund --prefix "$APP_DIR"
fi

# --- 5) restart SOLO si cambió backend ---
if [ "$NEEDS_RESTART" != true ]; then
  echo "==> Solo cambió frontend (deploy/). NO se reinicia → cero caída del servicio. Done."
  exit 0
fi

echo "==> Cambios en backend → reinicio del servicio"
rm -f "$LOCK_FILE"
systemctl restart "$SERVICE_NAME"

echo "==> Esperando arranque…"
sleep 3
systemctl is-active --quiet "$SERVICE_NAME" \
  && echo "==> $SERVICE_NAME ACTIVO" \
  || { echo "!! $SERVICE_NAME NO activo"; systemctl status "$SERVICE_NAME" --no-pager -l | head -20; exit 1; }

echo "==> Health check (puerto $PORT)"
for i in 1 2 3 4 5; do
  if curl -fsS "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then echo "==> /api/health OK"; break; fi
  echo "   …reintento $i"; sleep 2
done

echo "==> Últimas líneas del journal:"
journalctl -u "$SERVICE_NAME" -n 20 --no-pager 2>/dev/null || echo "(journal no accesible)"
echo "==> Done."
