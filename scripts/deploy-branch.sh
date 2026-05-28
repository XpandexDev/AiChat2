#!/usr/bin/env bash
set -euo pipefail

PUSH=false
REMOTE=false
for arg in "$@"; do
  case "$arg" in
    --push) PUSH=true ;;
    --remote) PUSH=true; REMOTE=true ;;
  esac
done

ROOT_DIR="$(git rev-parse --show-toplevel)"
FRONTEND_DIR="$ROOT_DIR/frontend"
DEPLOY_DIR="$ROOT_DIR/deploy"
WORKTREE_DIR="/private/tmp/$(basename "$ROOT_DIR")-deploy-worktree"
DEPLOY_BRANCH="deploy"
BASE_BRANCH="main"
VPS_HOST="${VPS_HOST:-root@151.241.216.125}"
VPS_APP_DIR="${VPS_APP_DIR:-/www/wwwroot/AiChat}"

echo "==> Building frontend into $DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR"
find "$DEPLOY_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

(
  cd "$FRONTEND_DIR"
  # Angular build crashes with current local Node; use stable Node for build.
  npx -y node@20.19.0 ./node_modules/@angular/cli/bin/ng build --output-path ../deploy
)

echo "==> Preparing deploy worktree at $WORKTREE_DIR"
if git -C "$ROOT_DIR" worktree list | grep -q "$WORKTREE_DIR"; then
  git -C "$ROOT_DIR" worktree remove --force "$WORKTREE_DIR"
fi

if git -C "$ROOT_DIR" show-ref --verify --quiet "refs/heads/$DEPLOY_BRANCH"; then
  git -C "$ROOT_DIR" worktree add --force "$WORKTREE_DIR" "$DEPLOY_BRANCH"
else
  git -C "$ROOT_DIR" worktree add --force -b "$DEPLOY_BRANCH" "$WORKTREE_DIR" "$BASE_BRANCH"
fi

echo "==> Syncing deploy folder into deploy branch"
find "$WORKTREE_DIR" -mindepth 1 -maxdepth 1 ! -name ".git" -exec rm -rf {} +
mkdir -p "$WORKTREE_DIR/deploy"
rsync -a --delete "$DEPLOY_DIR/" "$WORKTREE_DIR/deploy/"

# Copiar TODO backend/src/* a la raíz del worktree.
# Tras el refactor de Fase 1, server.js depende de config.js, db/, middleware/,
# modules/, etc. No vale con copiar solo server.js.
rsync -a \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='.baileys_auth/' \
  --exclude='.wwebjs_auth/' \
  --exclude='.wwebjs_cache/' \
  --exclude='node_modules/' \
  "$ROOT_DIR/backend/src/" "$WORKTREE_DIR/"

# Copiar README desde raíz
cp "$ROOT_DIR/README.md" "$WORKTREE_DIR/README_PROJECT.md"
cp "$ROOT_DIR/README_HOSTINGER.md" "$WORKTREE_DIR/README.md"

# Copiar el pull script al worktree (se versiona en deploy para que el VPS
# pueda invocarse a sí mismo con la versión más reciente).
mkdir -p "$WORKTREE_DIR/scripts"
cp "$ROOT_DIR/scripts/vps-deploy-pull.sh" "$WORKTREE_DIR/scripts/vps-deploy-pull.sh"
chmod +x "$WORKTREE_DIR/scripts/vps-deploy-pull.sh"

cat > "$WORKTREE_DIR/package.json" <<'JSON'
{
  "name": "chatbot-deploy-runtime",
  "private": true,
  "version": "1.0.0",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "engines": {
    "node": ">=18"
  },
  "dependencies": {
    "@whiskeysockets/baileys": "^6.7.18",
    "axios": "^1.16.0",
    "bcryptjs": "^2.4.3",
    "cookie-parser": "^1.4.6",
    "cors": "^2.8.6",
    "dotenv": "^17.4.2",
    "express": "^5.2.1",
    "express-rate-limit": "^7.3.0",
    "mysql2": "^3.11.3",
    "pino": "^9.5.0",
    "qrcode": "^1.5.4",
    "socket.io": "^4.8.3"
  }
}
JSON


(
  cd "$WORKTREE_DIR"
  git add -A
  if git diff --cached --quiet; then
    echo "==> No changes to commit on deploy branch"
  else
    git commit -m "Deploy build $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    echo "==> New deploy commit created"
  fi

  if $PUSH; then
    git push -u origin "$DEPLOY_BRANCH"
    echo "==> Deploy branch pushed to origin/$DEPLOY_BRANCH"
  fi
)

if $REMOTE; then
  echo "==> Triggering remote pull on $VPS_HOST:$VPS_APP_DIR"
  ssh -o StrictHostKeyChecking=accept-new "$VPS_HOST" \
    "bash $VPS_APP_DIR/scripts/vps-deploy-pull.sh"
fi

echo "==> Done"
echo "    build output: $DEPLOY_DIR"
echo "    branch sync:  $DEPLOY_BRANCH"
if $REMOTE; then
  echo "    remote:        $VPS_HOST → restarted"
fi
