#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${1:-}"
VERSION="${2:-latest}"
SOURCE_REF="$VERSION"
if [[ "$VERSION" == "latest" ]]; then SOURCE_REF="main"; fi
INSTALL_DIR="/opt/chat4newapi"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this installer with sudo or as root." >&2
  exit 1
fi
if [[ ! "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "Usage: install.sh GITHUB_OWNER/REPOSITORY [VERSION]" >&2
  exit 1
fi
if [[ ! -r /etc/os-release ]]; then
  echo "Cannot detect Linux distribution." >&2
  exit 1
fi
. /etc/os-release
if [[ "${ID:-}" != "ubuntu" && "${ID:-}" != "debian" ]]; then
  echo "Supported distributions: Ubuntu and Debian." >&2
  exit 1
fi

read -r -p "Chat domain (for example chat.example.com): " CHAT_DOMAIN </dev/tty
read -r -p "New API admin domain (for example newapi.example.com): " NEWAPI_DOMAIN </dev/tty
for domain in "$CHAT_DOMAIN" "$NEWAPI_DOMAIN"; do
  if [[ ! "$domain" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$ ]]; then
    echo "Invalid domain: $domain" >&2
    exit 1
  fi
done
if [[ "$CHAT_DOMAIN" == "$NEWAPI_DOMAIN" ]]; then
  echo "Chat and New API need separate hostnames." >&2
  exit 1
fi
if [[ -e "$INSTALL_DIR/.env" ]]; then
  echo "An installation already exists at $INSTALL_DIR. Use chat4newapi update." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo "Installing Docker Engine and the Compose plugin on this VPS..."
  apt-get update
  apt-get install -y ca-certificates curl openssl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
    "$(dpkg --print-architecture)" "$ID" "$VERSION_CODENAME" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

if ! command -v openssl >/dev/null 2>&1; then
  apt-get update
  apt-get install -y openssl
fi

mkdir -p "$INSTALL_DIR" "$INSTALL_DIR/backups"
chmod 700 "$INSTALL_DIR"
RAW="https://raw.githubusercontent.com/${REPO}/${SOURCE_REF}/deploy"
curl -fsSL "$RAW/compose.yaml" -o "$INSTALL_DIR/compose.yaml"
curl -fsSL "$RAW/Caddyfile" -o "$INSTALL_DIR/Caddyfile"
curl -fsSL "$RAW/manage.sh" -o "$INSTALL_DIR/manage.sh"
chmod 700 "$INSTALL_DIR/manage.sh"

IMAGE="ghcr.io/$(printf '%s' "$REPO" | tr '[:upper:]' '[:lower:]'):${VERSION}"
APP_KEY="$(openssl rand -hex 32)"
NEWAPI_SESSION="$(openssl rand -hex 32)"
NEWAPI_CRYPTO="$(openssl rand -hex 32)"
SETUP_TOKEN="$(openssl rand -hex 32)"
umask 077
cat > "$INSTALL_DIR/.env" <<EOF
CHAT_DOMAIN=${CHAT_DOMAIN}
NEWAPI_DOMAIN=${NEWAPI_DOMAIN}
CHAT_IMAGE=${IMAGE}
GITHUB_REPOSITORY=${REPO}
DEPLOY_REF=${SOURCE_REF}
APP_ENCRYPTION_KEY=${APP_KEY}
NEWAPI_SESSION_SECRET=${NEWAPI_SESSION}
NEWAPI_CRYPTO_SECRET=${NEWAPI_CRYPTO}
SETUP_TOKEN=${SETUP_TOKEN}
EOF
mkdir -p "$INSTALL_DIR/data/chat" "$INSTALL_DIR/data/newapi"
chmod 700 "$INSTALL_DIR/data" "$INSTALL_DIR/data/chat" "$INSTALL_DIR/data/newapi"
chown -R 1000:1000 "$INSTALL_DIR/data/chat"
systemctl enable --now docker

echo "Make sure both DNS records point to this VPS and ports 80/443 are reachable."
docker compose --env-file "$INSTALL_DIR/.env" -f "$INSTALL_DIR/compose.yaml" pull
docker compose --env-file "$INSTALL_DIR/.env" -f "$INSTALL_DIR/compose.yaml" up -d
ln -sf "$INSTALL_DIR/manage.sh" /usr/local/bin/chat4newapi

cat <<EOF

Deployment started.
  Chat:       https://${CHAT_DOMAIN}
  New API:    https://${NEWAPI_DOMAIN}
  Install:    ${INSTALL_DIR}
  Manage:     chat4newapi status|backup|update|restore
  Setup token: ${SETUP_TOKEN}

Complete the New API first-run admin setup, configure provider channels, then
create an API token and add it in the chat site's /admin page. The chat site's
first visit will prompt you to create its separate administrator account.
EOF
