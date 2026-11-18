#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$INSTALL_DIR"
COMPOSE=(docker compose --env-file .env -f compose.yaml)
ACTION="${1:-status}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

backup() {
  mkdir -p backups
  "${COMPOSE[@]}" exec -T chat node server/backup.mjs
  "${COMPOSE[@]}" stop chat new-api
  trap '"${COMPOSE[@]}" start new-api chat >/dev/null 2>&1 || true' RETURN
  tar -czf "backups/chat4newapi-${STAMP}.tar.gz" .env compose.yaml Caddyfile data/chat/.backup data/newapi
  chmod 600 "backups/chat4newapi-${STAMP}.tar.gz"
  rm -rf -- data/chat/.backup
  "${COMPOSE[@]}" start new-api chat
  trap - RETURN
  find backups -maxdepth 1 -type f -name 'chat4newapi-*.tar.gz' -printf '%T@ %p\n' | sort -nr | tail -n +8 | cut -d' ' -f2- | xargs -r rm --
  echo "Backup written: backups/chat4newapi-${STAMP}.tar.gz"
}

case "$ACTION" in
  status)
    "${COMPOSE[@]}" ps
    ;;
  backup)
    backup
    ;;
  update)
    backup
    VERSION="${2:-latest}"
    [[ "$VERSION" =~ ^[A-Za-z0-9_.-]+$ && "$VERSION" != "." && "$VERSION" != ".." ]] || { echo "Invalid image version." >&2; exit 2; }
    REPO="$(sed -n 's/^GITHUB_REPOSITORY=//p' .env)"
    [[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "Missing GITHUB_REPOSITORY in .env." >&2; exit 1; }
    SOURCE_REF="$VERSION"
    if [[ "$VERSION" == "latest" ]]; then SOURCE_REF="main"; fi
    RAW="https://raw.githubusercontent.com/${REPO}/${SOURCE_REF}/deploy"
    curl -fsSL "$RAW/compose.yaml" -o compose.yaml.new
    curl -fsSL "$RAW/Caddyfile" -o Caddyfile.new
    curl -fsSL "$RAW/manage.sh" -o manage.sh.new
    IMAGE_PREFIX="ghcr.io/$(printf '%s' "$REPO" | tr '[:upper:]' '[:lower:]')"
    sed -i "s|^CHAT_IMAGE=.*|CHAT_IMAGE=${IMAGE_PREFIX}:${VERSION}|" .env
    sed -i "s|^DEPLOY_REF=.*|DEPLOY_REF=${SOURCE_REF}|" .env
    mv compose.yaml.new compose.yaml
    mv Caddyfile.new Caddyfile
    mv manage.sh.new manage.sh
    chmod 700 manage.sh
    "${COMPOSE[@]}" pull
    "${COMPOSE[@]}" up -d --remove-orphans
    ;;
  restore)
    ARCHIVE="${2:-$(find backups -maxdepth 1 -type f -name 'chat4newapi-*.tar.gz' -printf '%T@ %p\n' | sort -nr | head -n 1 | cut -d' ' -f2-)}"
    [[ -n "$ARCHIVE" && -f "$ARCHIVE" ]] || { echo "Backup archive not found." >&2; exit 1; }
    read -r -p "This replaces current data with $ARCHIVE. Type RESTORE to continue: " CONFIRM
    [[ "$CONFIRM" == "RESTORE" ]] || exit 1
    backup
    TEMP_DIR="$(mktemp -d)"
    tar -xzf "$ARCHIVE" -C "$TEMP_DIR"
    "${COMPOSE[@]}" stop chat new-api
    trap 'rm -rf -- "$TEMP_DIR"; "${COMPOSE[@]}" start new-api chat >/dev/null 2>&1 || true' EXIT
    rm -rf -- data/chat data/newapi
    mkdir -p data/chat data/newapi
    cp -a "$TEMP_DIR/data/newapi/." data/newapi/
    cp -a "$TEMP_DIR/data/chat/.backup/chat.sqlite" data/chat/chat.sqlite
    cp -a "$TEMP_DIR/data/chat/.backup/files" data/chat/files
    cp -a "$TEMP_DIR/.env" .env
    cp -a "$TEMP_DIR/compose.yaml" compose.yaml
    cp -a "$TEMP_DIR/Caddyfile" Caddyfile
    rm -rf -- "$TEMP_DIR"
    chown -R 1000:1000 data/chat
    "${COMPOSE[@]}" up -d
    trap - EXIT
    ;;
  uninstall)
    read -r -p "Remove containers and configuration but keep data? [Y/n] " KEEP
    "${COMPOSE[@]}" down
    if [[ "${KEEP,,}" == "n" ]]; then
      read -r -p "Type DELETE to remove all local chat and New API data: " CONFIRM
      [[ "$CONFIRM" == "DELETE" ]] || exit 1
      rm -rf -- "$INSTALL_DIR/data"
    fi
    ;;
  *)
    echo "Usage: chat4newapi {status|backup|update [version]|restore [archive]|uninstall}" >&2
    exit 2
    ;;
esac
