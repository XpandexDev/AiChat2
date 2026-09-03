#!/usr/bin/env bash
# Despliegue a VPS-Prod SIN pasar por GitHub.
#
# Por qué existe: el repo es privado y el VPS no tiene credenciales de GitHub
# guardadas (el usuario "www" no puede autenticarse), así que
# `git fetch origin deploy` falla con "could not read Username". En lugar de
# poner un token o una deploy key en el servidor, el commit viaja por SSH dentro
# de un `git bundle` — que git acepta como remoto — y el script de pull habitual
# (vps-deploy-pull.sh) hace el resto sin cambio alguno: backup de credenciales,
# reset, npm install si toca y reinicio SOLO si cambió el backend.
#
# Uso:
#   scripts/deploy-branch.sh          # construye el frontend y actualiza la rama deploy
#   scripts/deploy-bundle.sh          # envía esa rama al VPS y despliega
#
# El bundle es incremental (desde el HEAD que tenga el VPS), así que pesa KBs.

set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel)"
VPS_HOST="${VPS_HOST:-root@151.241.216.125}"
VPS_APP_DIR="${VPS_APP_DIR:-/www/wwwroot/AiChat}"
DEPLOY_BRANCH="deploy"
BUNDLE_LOCAL="$(mktemp -t aichat-deploy).bundle"

cleanup() { rm -f "$BUNDLE_LOCAL"; }
trap cleanup EXIT

echo "==> Consultando el HEAD actual del VPS"
REMOTE_HEAD=$(ssh -o ConnectTimeout=15 "$VPS_HOST" \
  "sudo -u www git -C $VPS_APP_DIR rev-parse HEAD")
echo "    VPS está en $REMOTE_HEAD"

LOCAL_HEAD=$(git -C "$ROOT_DIR" rev-parse "refs/heads/$DEPLOY_BRANCH")
if [ "$REMOTE_HEAD" = "$LOCAL_HEAD" ]; then
  echo "==> El VPS ya está en $LOCAL_HEAD. Nada que desplegar."
  exit 0
fi

# Bundle incremental. Si el VPS tiene un commit que no conocemos (deriva), el
# bundle no se puede construir: mejor fallar aquí que desplegar a ciegas.
echo "==> Creando bundle incremental $REMOTE_HEAD..$LOCAL_HEAD"
git -C "$ROOT_DIR" bundle create "$BUNDLE_LOCAL" \
  "$REMOTE_HEAD..refs/heads/$DEPLOY_BRANCH"

echo "==> Enviando bundle ($(du -h "$BUNDLE_LOCAL" | cut -f1))"
# El bundle del deploy anterior queda en /tmp a nombre de www; con
# fs.protected_regular ni root puede sobrescribirlo en un directorio sticky,
# así que lo borramos antes de subir el nuevo.
ssh -o ConnectTimeout=15 "$VPS_HOST" 'rm -f /tmp/aichat-deploy.bundle'
scp -o ConnectTimeout=15 "$BUNDLE_LOCAL" "$VPS_HOST:/tmp/aichat-deploy.bundle"

echo "==> Desplegando en el VPS"
ssh -o ConnectTimeout=15 "$VPS_HOST" "APP_DIR=$VPS_APP_DIR bash -s" <<'REMOTE'
set -euo pipefail
APP_DIR="${APP_DIR:-/www/wwwroot/AiChat}"
BUNDLE=/tmp/aichat-deploy.bundle

ORIGIN_URL=$(sudo -u www git -C "$APP_DIR" remote get-url origin)
restore() { sudo -u www git -C "$APP_DIR" remote set-url origin "$ORIGIN_URL"; }
trap restore EXIT

chown www:www "$BUNDLE"
sudo -u www git -C "$APP_DIR" remote set-url origin "$BUNDLE"
bash "$APP_DIR/scripts/vps-deploy-pull.sh"
REMOTE

echo "==> Listo. VPS en $LOCAL_HEAD"
