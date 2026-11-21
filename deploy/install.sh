#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${1:-}"
IMAGE_VERSION="${2:-latest}"
SOURCE_REF="$IMAGE_VERSION"
if [[ "$IMAGE_VERSION" == "latest" ]]; then SOURCE_REF="main"; fi
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
if [[ ! "$CHAT_DOMAIN" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$ ]]; then
  echo "Invalid chat domain: $CHAT_DOMAIN" >&2
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
if ! command -v curl >/dev/null 2>&1; then
  apt-get update
  apt-get install -y curl
fi

docker network inspect chat4newapi-models >/dev/null 2>&1 || docker network create chat4newapi-models >/dev/null

DEFAULT_MODEL_API_URL=""
while IFS=$'\t' read -r container image; do
  if [[ "${container,,} ${image,,}" =~ (new[-_]?api|sub2[-_]?api) ]]; then
    while IFS= read -r mapping; do
      [[ -n "$mapping" ]] || continue
      internal_port="${mapping%%/*}"
      host_port="${mapping##*:}"
      status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${host_port}/v1/models" 2>/dev/null || true)"
      if [[ "$status" =~ ^(200|401|403)$ ]]; then
        if [[ "$mapping" == *"127.0.0.1:"* ]]; then
          docker network connect "$container" chat4newapi-models >/dev/null 2>&1 || true
          DEFAULT_MODEL_API_URL="http://${container}:${internal_port}"
        else
          DEFAULT_MODEL_API_URL="http://host.docker.internal:${host_port}"
        fi
        echo "Detected ${container} (${image}) as a local model gateway."
        break 2
      fi
    done < <(docker port "$container" 2>/dev/null | sed -nE 's#^([0-9]+/tcp) -> .*:([0-9]+)$#\1 -> \2#p')
  fi
done < <(docker ps --format '{{.Names}}\t{{.Image}}')

if [[ -z "$DEFAULT_MODEL_API_URL" ]]; then
  for port in 3000 3001 8080 8000; do
    status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${port}/v1/models" 2>/dev/null || true)"
    if [[ "$status" =~ ^(200|401|403)$ ]]; then
      DEFAULT_MODEL_API_URL="http://host.docker.internal:${port}"
      echo "Detected an API-compatible model service on port ${port}."
      break
    fi
  done
fi

if [[ -z "$DEFAULT_MODEL_API_URL" ]]; then
  read -r -p "No local model gateway detected. Install upstream New API separately? [Y/n] " INSTALL_NEWAPI </dev/tty
  if [[ "${INSTALL_NEWAPI,,}" != "n" ]]; then
    NEWAPI_DIR="/opt/new-api-upstream"
    if [[ -e "$NEWAPI_DIR/compose.yaml" ]]; then
      echo "An upstream New API Compose file already exists at $NEWAPI_DIR; leaving it untouched."
    else
    mkdir -p "$NEWAPI_DIR/data"
    chmod 700 "$NEWAPI_DIR" "$NEWAPI_DIR/data"
    NEWAPI_SESSION="$(openssl rand -hex 32)"
    NEWAPI_CRYPTO="$(openssl rand -hex 32)"
    cat > "$NEWAPI_DIR/compose.yaml" <<EOF
services:
  new-api:
    image: calciumion/new-api:latest
    restart: unless-stopped
    environment:
      TZ: Asia/Shanghai
      SESSION_SECRET: ${NEWAPI_SESSION}
      CRYPTO_SECRET: ${NEWAPI_CRYPTO}
    ports:
      - "127.0.0.1:3300:3000"
    volumes:
      - ./data:/data
    networks:
      models:
        aliases:
          - upstream-new-api

networks:
  models:
    name: chat4newapi-models
    external: true
EOF
    (cd "$NEWAPI_DIR" && docker compose -p new-api-upstream -f compose.yaml pull && docker compose -p new-api-upstream -f compose.yaml up -d)
    DEFAULT_MODEL_API_URL="http://upstream-new-api:3000"
    fi
  fi
fi

mkdir -p "$INSTALL_DIR" "$INSTALL_DIR/backups"
chmod 700 "$INSTALL_DIR"
RAW="https://raw.githubusercontent.com/${REPO}/${SOURCE_REF}/deploy"
curl -fsSL "$RAW/compose.yaml" -o "$INSTALL_DIR/compose.yaml"
curl -fsSL "$RAW/Caddyfile" -o "$INSTALL_DIR/Caddyfile"
curl -fsSL "$RAW/manage.sh" -o "$INSTALL_DIR/manage.sh"
chmod 700 "$INSTALL_DIR/manage.sh"

IMAGE="ghcr.io/$(printf '%s' "$REPO" | tr '[:upper:]' '[:lower:]'):${IMAGE_VERSION}"
APP_KEY="$(openssl rand -hex 32)"
SETUP_TOKEN="$(openssl rand -hex 32)"
umask 077
cat > "$INSTALL_DIR/.env" <<EOF
CHAT_DOMAIN=${CHAT_DOMAIN}
CHAT_IMAGE=${IMAGE}
GITHUB_REPOSITORY=${REPO}
DEPLOY_REF=${SOURCE_REF}
APP_ENCRYPTION_KEY=${APP_KEY}
DEFAULT_MODEL_API_URL=${DEFAULT_MODEL_API_URL}
SETUP_TOKEN=${SETUP_TOKEN}
EOF
mkdir -p "$INSTALL_DIR/data/chat"
chmod 700 "$INSTALL_DIR/data" "$INSTALL_DIR/data/chat"
chown -R 1000:1000 "$INSTALL_DIR/data/chat"
systemctl enable --now docker

echo "Make sure both DNS records point to this VPS and ports 80/443 are reachable."
docker compose --env-file "$INSTALL_DIR/.env" -f "$INSTALL_DIR/compose.yaml" pull
docker compose --env-file "$INSTALL_DIR/.env" -f "$INSTALL_DIR/compose.yaml" up -d
ln -sf "$INSTALL_DIR/manage.sh" /usr/local/bin/chat4newapi

cat <<EOF

Deployment started.
  Chat:       https://${CHAT_DOMAIN}
  Model API:  ${DEFAULT_MODEL_API_URL:-configure it at https://${CHAT_DOMAIN}/admin}
  Install:    ${INSTALL_DIR}
  Manage:     chat4newapi status|backup|update|restore
  Setup token: ${SETUP_TOKEN}

The chat app runs independently of the model gateway. Configure an
Anthropic Messages, OpenAI Chat Completions, or OpenAI Responses gateway at /admin. If New API was
installed separately, its dashboard is bound to localhost:3300; use an SSH
tunnel to complete its first-run setup and create an API token.
The chat site's first visit prompts you to create its administrator account.
EOF
