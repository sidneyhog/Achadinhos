#!/usr/bin/env bash
# Instalador do Achadinhos para Ubuntu na VPS.
# Rode na VPS, como root, a partir de uma cópia do projeto:
#   sudo bash instalador/instalar.sh
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Rode com sudo: sudo bash instalador/instalar.sh" >&2
  exit 1
fi

if [[ ! -f /etc/os-release ]] || ! grep -qi ubuntu /etc/os-release; then
  echo "Este instalador é para Ubuntu." >&2
  exit 1
fi

SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ask() {
  local prompt="$1" default="${2:-}" value
  if [[ -n "$default" ]]; then
    read -r -p "$prompt [$default]: " value
    printf '%s\n' "${value:-$default}"
  else
    read -r -p "$prompt: " value
    printf '%s\n' "$value"
  fi
}

port_busy() {
  local port="$1"
  ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "(^|:|\\])${port}$"
}

nginx_owns() {
  local port="$1"
  ss -ltnpH 2>/dev/null | awk -v port="$port" '$4 ~ ":" port "$" && /nginx/ { found=1 } END { exit !found }'
}

suggest_port() {
  local port="$1"
  while port_busy "$port"; do
    port=$((port + 1))
    if (( port > 65535 )); then
      echo "Não achei porta livre a partir de $1." >&2
      exit 1
    fi
  done
  printf '%s\n' "$port"
}

ask_port() {
  local prompt="$1" suggestion="$2" value
  suggestion="$(suggest_port "$suggestion")"
  while true; do
    value="$(ask "$prompt" "$suggestion")"
    if [[ ! "$value" =~ ^[0-9]+$ ]] || (( value < 1 || value > 65535 )); then
      echo "Use um número de 1 a 65535." >&2
      continue
    fi
    if port_busy "$value"; then
      echo "A porta ${value} já está em uso. Escolha outra." >&2
      suggestion="$(suggest_port $((value + 1)))"
      continue
    fi
    printf '%s\n' "$value"
    return
  done
}

valid_domain() {
  [[ "$1" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[A-Za-z]{2,}$ ]]
}

write_nginx_http() {
  cat > "$NGINX_SITE" <<EOF
server {
  listen ${HTTP_PORT};
  listen [::]:${HTTP_PORT};
  server_name ${DOMAIN};

  client_max_body_size 12m;

  location /.well-known/acme-challenge/ {
    root /var/www/certbot;
  }

  location / {
    proxy_pass http://127.0.0.1:${WEB_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 120s;
  }
}
EOF
}

write_nginx_tls_custom() {
  cat > "$NGINX_SITE" <<EOF
server {
  listen ${HTTP_PORT};
  listen [::]:${HTTP_PORT};
  server_name ${DOMAIN};

  location /.well-known/acme-challenge/ {
    root /var/www/certbot;
  }

  location / {
    return 301 https://\$host:${HTTPS_PORT}\$request_uri;
  }
}

server {
  listen ${HTTPS_PORT} ssl;
  listen [::]:${HTTPS_PORT} ssl;
  server_name ${DOMAIN};

  ssl_certificate ${CERT_DIR}/fullchain.pem;
  ssl_certificate_key ${CERT_DIR}/privkey.pem;
  client_max_body_size 12m;

  location / {
    proxy_pass http://127.0.0.1:${WEB_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 120s;
  }
}
EOF
}

echo
echo "Achadinhos — instalação na VPS"
echo "O DNS do domínio precisa apontar para este servidor antes do certificado."
echo "O Let's Encrypt só consegue emitir o certificado se a porta 80 estiver livre e aberta."
echo

APP_USER="$(ask "Usuário do sistema que vai ser dono da instalação" "deploy")"
if [[ ! "$APP_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; then
  echo "Nome de usuário inválido." >&2
  exit 1
fi

# Pasta própria por padrão: a cópia usa rsync --delete, que apaga da pasta de destino tudo o que não veio do projeto.
# Instalar direto na home (/home/deploy) apagava .ssh, .bashrc e qualquer outro projeto guardado ali.
DEFAULT_DIR="/home/${APP_USER}/achadinhos"
INSTALL_DIR="$(ask "Pasta da instalação (Enter usa ${DEFAULT_DIR})" "$DEFAULT_DIR")"
INSTALL_DIR="${INSTALL_DIR%/}"
if [[ "$INSTALL_DIR" != /* ]]; then
  echo "A pasta precisa ser um caminho absoluto, por exemplo ${DEFAULT_DIR}." >&2
  exit 1
fi
case "$INSTALL_DIR" in
  ""|/|/home|/root|/opt|/srv|/var|/etc|/usr)
    echo "Escolha uma pasta só do Achadinhos, por exemplo ${DEFAULT_DIR}." >&2
    exit 1
    ;;
esac
# Pasta que já tem arquivos e não é uma instalação anterior do Achadinhos: recusa, para não apagar outro projeto.
if [[ -d "$INSTALL_DIR" && -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" && ! -f "$INSTALL_DIR/.instalador.env" && "$(realpath "$INSTALL_DIR")" != "$(realpath "$SOURCE")" ]]; then
  echo "A pasta ${INSTALL_DIR} já tem arquivos e não é uma instalação do Achadinhos. Escolha uma pasta vazia ou nova." >&2
  exit 1
fi
# Instalações antigas ficaram na própria home do usuário. Nelas a cópia continua, mas sem apagar nada.
SYNC_DELETE="--delete"
if [[ "$INSTALL_DIR" == "/home/${APP_USER}" || "$INSTALL_DIR" =~ ^/home/[^/]+$ ]]; then
  SYNC_DELETE=""
  echo "Aviso: ${INSTALL_DIR} é uma pasta home. A cópia não vai apagar arquivos antigos dela. Para as próximas, prefira ${DEFAULT_DIR}."
fi

DOMAIN=""
while [[ -z "$DOMAIN" ]]; do
  DOMAIN="$(ask "Domínio (ex.: painel.suaempresa.com)" "")"
  DOMAIN="${DOMAIN,,}"
  if ! valid_domain "$DOMAIN"; then
    echo "Domínio inválido." >&2
    DOMAIN=""
  fi
done

LE_EMAIL="$(ask "E-mail para o aviso de vencimento do certificado" "admin@${DOMAIN}")"

KEEP_ENV=0
if [[ -f "$INSTALL_DIR/.env" ]]; then
  KEEP_ENV=1
  echo "Já existe ${INSTALL_DIR}/.env. Segredos e senha do super admin serão mantidos."
  ADMIN_EMAIL="$(grep -E '^ADMIN_EMAIL=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2- || true)"
  ADMIN_PASSWORD=""
else
  ADMIN_EMAIL="$(ask "E-mail do super admin" "$LE_EMAIL")"
  while true; do
    read -r -s -p "Senha do super admin (mínimo 8 caracteres): " ADMIN_PASSWORD
    echo
    if ((${#ADMIN_PASSWORD} >= 8)); then
      break
    fi
    echo "A senha precisa ter pelo menos 8 caracteres." >&2
  done
fi

echo
SHARED_NGINX=0
if nginx_owns 80 && nginx_owns 443; then
  SHARED_NGINX=1
  HTTP_PORT=80
  HTTPS_PORT=443
  echo "O Nginx deste servidor já usa as portas 80 e 443. O domínio entra nele, junto com os sites que já existem."
else
  echo "Portas. Enter aceita a sugestão. Se ela estiver ocupada, o instalador oferece a próxima livre."
  HTTP_PORT="$(ask_port "Porta HTTP pública" 80)"
  HTTPS_PORT="$(ask_port "Porta HTTPS pública" 443)"
  if [[ "$HTTPS_PORT" == "$HTTP_PORT" ]]; then
    echo "HTTP e HTTPS precisam de portas diferentes." >&2
    exit 1
  fi
fi
WEB_PORT="$(ask_port "Porta local do painel (só este servidor acessa)" 8080)"
if [[ "$WEB_PORT" == "$HTTP_PORT" || "$WEB_PORT" == "$HTTPS_PORT" ]]; then
  echo "A porta local não pode ser a mesma da porta pública." >&2
  exit 1
fi

if [[ "$KEEP_ENV" == "0" ]]; then
  SANDBOX="$(ask "EFI em sandbox? (sim/nao)" "sim")"
  if [[ "$SANDBOX" == "nao" || "$SANDBOX" == "não" || "$SANDBOX" == "n" ]]; then
    EFI_SANDBOX="false"
  else
    EFI_SANDBOX="true"
  fi
fi

echo
echo "Usuário: ${APP_USER}"
echo "Pasta:   ${INSTALL_DIR}"
echo "Domínio: ${DOMAIN}"
echo "HTTP ${HTTP_PORT} · HTTPS ${HTTPS_PORT} · painel local ${WEB_PORT}"
CONFIRM="$(ask "Continuar? (sim/nao)" "sim")"
if [[ "$CONFIRM" != "sim" && "$CONFIRM" != "s" ]]; then
  echo "Instalação cancelada."
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg nginx certbot python3-certbot-nginx rsync openssl

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker
if ! docker compose version >/dev/null 2>&1; then
  echo "O Docker Compose não ficou disponível." >&2
  exit 1
fi

if id "$APP_USER" >/dev/null 2>&1; then
  echo "Usuário ${APP_USER} já existe."
elif [[ -d "/home/${APP_USER}" ]]; then
  useradd --home "/home/${APP_USER}" --shell /bin/bash "$APP_USER"
  echo "Usuário ${APP_USER} criado na pasta /home/${APP_USER}, que já existia."
else
  useradd --create-home --shell /bin/bash "$APP_USER"
  echo "Usuário ${APP_USER} criado, com home /home/${APP_USER}."
fi
usermod -aG docker "$APP_USER" || true

mkdir -p "$INSTALL_DIR" /var/www/certbot
if [[ "$(realpath "$SOURCE")" != "$(realpath "$INSTALL_DIR")" ]]; then
  rsync -a ${SYNC_DELETE} \
    --exclude node_modules \
    --exclude dist \
    --exclude .git \
    --exclude .env \
    --exclude .zapo-auth \
    --exclude .instalador.env \
    --exclude certificados \
    "$SOURCE"/ "$INSTALL_DIR"/
fi

if [[ "$KEEP_ENV" == "0" ]]; then
  JWT_SECRET="$(openssl rand -hex 32)"
  APP_SECRET="$(openssl rand -hex 32)"
  POSTGRES_PASSWORD="$(openssl rand -hex 24)"
  EFI_WEBHOOK_SECRET="$(openssl rand -hex 24)"
  umask 077
  cat > "$INSTALL_DIR/.env" <<EOF
JWT_SECRET=${JWT_SECRET}
APP_SECRET=${APP_SECRET}
ADMIN_EMAIL=${ADMIN_EMAIL}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
WEB_BIND=127.0.0.1
WEB_PORT=${WEB_PORT}
EFI_CLIENT_ID=
EFI_CLIENT_SECRET=
EFI_PIX_KEY=
EFI_CERT_PATH=
EFI_CERT_PASSWORD=
EFI_SANDBOX=${EFI_SANDBOX}
EFI_WEBHOOK_SECRET=${EFI_WEBHOOK_SECRET}
EOF
  umask 022
else
  # Instalações antigas não tinham o segredo do webhook; sem ele a API recusa as confirmações de pagamento.
  if ! grep -Eq '^EFI_WEBHOOK_SECRET=.+' "$INSTALL_DIR/.env"; then
    sed -i '/^EFI_WEBHOOK_SECRET=/d' "$INSTALL_DIR/.env"
    echo "EFI_WEBHOOK_SECRET=$(openssl rand -hex 24)" >> "$INSTALL_DIR/.env"
    echo "Gerei EFI_WEBHOOK_SECRET no .env. Cadastre de novo o webhook na EFI com a URL que aparece no fim."
  fi
  if grep -q '^WEB_PORT=' "$INSTALL_DIR/.env"; then
    sed -i "s/^WEB_PORT=.*/WEB_PORT=${WEB_PORT}/" "$INSTALL_DIR/.env"
  else
    echo "WEB_PORT=${WEB_PORT}" >> "$INSTALL_DIR/.env"
  fi
  if grep -q '^WEB_BIND=' "$INSTALL_DIR/.env"; then
    sed -i "s/^WEB_BIND=.*/WEB_BIND=127.0.0.1/" "$INSTALL_DIR/.env"
  else
    echo "WEB_BIND=127.0.0.1" >> "$INSTALL_DIR/.env"
  fi
fi

chown -R "$APP_USER:$APP_USER" "$INSTALL_DIR"
chmod 600 "$INSTALL_DIR/.env"

umask 077
cat > "$INSTALL_DIR/.instalador.env" <<EOF
APP_USER=${APP_USER}
INSTALL_DIR=${INSTALL_DIR}
DOMAIN=${DOMAIN}
HTTP_PORT=${HTTP_PORT}
HTTPS_PORT=${HTTPS_PORT}
WEB_PORT=${WEB_PORT}
LE_EMAIL=${LE_EMAIL}
EOF
umask 022
chown "$APP_USER:$APP_USER" "$INSTALL_DIR/.instalador.env"
chmod 600 "$INSTALL_DIR/.instalador.env"

cd "$INSTALL_DIR"
docker compose up -d --build

NGINX_SITE="/etc/nginx/sites-available/achadinhos.conf"
CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"
if [[ "$HTTP_PORT" == "80" && "$SHARED_NGINX" == "0" ]]; then
  rm -f /etc/nginx/sites-enabled/default
fi

write_nginx_http
ln -sfn "$NGINX_SITE" /etc/nginx/sites-enabled/achadinhos.conf
nginx -t
systemctl enable --now nginx
systemctl reload nginx

if [[ "$HTTP_PORT" != "80" ]]; then
  echo "A porta HTTP não é 80. O Let's Encrypt não emite certificado nesse caso. O site fica só em HTTP."
elif [[ ! -f "${CERT_DIR}/fullchain.pem" ]]; then
  if [[ "$HTTPS_PORT" == "443" ]]; then
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$LE_EMAIL" --redirect || echo "O certificado não saiu. Confira se o DNS aponta para esta VPS e rode o instalador de novo."
  else
    certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN" --non-interactive --agree-tos -m "$LE_EMAIL" || echo "O certificado não saiu. Confira se o DNS aponta para esta VPS e rode o instalador de novo."
  fi
fi

if [[ -f "${CERT_DIR}/fullchain.pem" && "$HTTPS_PORT" != "443" ]]; then
  write_nginx_tls_custom
  nginx -t
  systemctl reload nginx
fi

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow "${HTTP_PORT}/tcp"
  ufw allow "${HTTPS_PORT}/tcp"
fi

PUBLIC_HTTP="http://${DOMAIN}"
PUBLIC_HTTPS="https://${DOMAIN}"
[[ "$HTTP_PORT" != "80" ]] && PUBLIC_HTTP="http://${DOMAIN}:${HTTP_PORT}"
[[ "$HTTPS_PORT" != "443" ]] && PUBLIC_HTTPS="https://${DOMAIN}:${HTTPS_PORT}"

echo
if [[ -f "${CERT_DIR}/fullchain.pem" ]]; then
  echo "Pronto. Abra ${PUBLIC_HTTPS}"
else
  echo "O painel responde em ${PUBLIC_HTTP}."
fi
echo "Super admin: ${ADMIN_EMAIL:-o e-mail gravado no .env}"
echo "Segredos: ${INSTALL_DIR}/.env"
echo "Webhook da EFI: https://${DOMAIN}/api/billing/webhook?hmac=<valor de EFI_WEBHOOK_SECRET no .env>&ignorar="
echo "Postgres, Redis e o painel Docker ficam só nesta máquina. O Nginx encaminha o domínio para 127.0.0.1:${WEB_PORT}."
