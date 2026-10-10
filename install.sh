#!/usr/bin/env bash
# Enodia installer: sets Enodia up next to your Traefik, or Traefik and Enodia together if you have none.
#
#   curl -fsSL https://raw.githubusercontent.com/georgemos940/enodia-traefik/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/georgemos940/enodia-traefik/main/install.sh | bash -s -- update
#   curl -fsSL https://raw.githubusercontent.com/georgemos940/enodia-traefik/main/install.sh | bash -s -- uninstall [--purge]
#
# It works out the rest:
#   Traefik in Docker (flags, env, traefik.yml or .toml)  -> Enodia joins its network
#   Traefik as a Docker Swarm service                      -> Enodia as a stack on the same network
#   Traefik on the host (binary, systemd) or elsewhere     -> Enodia uses the host network
#   no Traefik at all                                      -> Traefik and Enodia, ready to use
#   no Docker, but Node.js 20+                             -> Enodia as a systemd service
#
# Settings it would otherwise ask for (environment variables or --flags):
#   ENODIA_DIR / --dir=PATH          where it lives (default /opt/enodia as root, ~/enodia otherwise)
#   ENODIA_DOMAIN / --domain=HOST    serve Enodia through Traefik on this host name
#   ENODIA_PASSWORD / --password=X   login password (default: a random one, printed once)
#   ENODIA_PORT / --port=N           local port when there is no domain (default 3000)
#   ENODIA_VERSION / --version=TAG   image or release tag (default latest)
#   ACME_EMAIL / --email=ADDR        Let's Encrypt e-mail when it sets up a new Traefik
#   TRAEFIK_CONTAINER                the Traefik container to use (asks when there are several)
#   TRAEFIK_API_URL / --api=URL      skip the search, use this API address
#   ENODIA_MODE / --mode=M           force a mode: docker, swarm, host, stack or node
#   ASSUME_YES=1 / --yes             never ask, take the defaults
set -euo pipefail

REPO="georgemos940/enodia-traefik"
IMAGE="ghcr.io/georgemos940/enodia"
RAW="https://raw.githubusercontent.com/${REPO}/main/install.sh"

ACTION="install"; PURGE=""
for a in "$@"; do
  case "$a" in
    install|update|upgrade|uninstall|remove|help|-h|--help) ACTION="$a" ;;
    --purge) PURGE=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --dir=*) ENODIA_DIR="${a#*=}" ;;
    --domain=*) ENODIA_DOMAIN="${a#*=}" ;;
    --password=*) ENODIA_PASSWORD="${a#*=}" ;;
    --port=*) ENODIA_PORT="${a#*=}" ;;
    --version=*) ENODIA_VERSION="${a#*=}" ;;
    --email=*) ACME_EMAIL="${a#*=}" ;;
    --api=*) TRAEFIK_API_URL="${a#*=}" ;;
    --mode=*) ENODIA_MODE="${a#*=}" ;;
    *) printf 'Unknown option %s (see --help)\n' "$a" >&2; exit 2 ;;
  esac
done
TAG="${ENODIA_VERSION:-latest}"
PORT="${ENODIA_PORT:-3000}"
case "${ENODIA_MODE:-}" in ''|docker|swarm|host|stack|node) ;; *) printf 'Unknown mode %s\n' "$ENODIA_MODE" >&2; exit 2 ;; esac

if [ -t 1 ]; then B=$'\e[1m'; D=$'\e[2m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; A=$'\e[38;5;214m'; N=$'\e[0m'; else B= D= G= Y= R= A= N=; fi
say()  { printf '%s\n' "$*"; }
step() { printf '%s›%s %s\n' "$A" "$N" "$*"; }
ok()   { printf '%s✓%s %s\n' "$G" "$N" "$*"; }
note() { printf '  %s%s%s\n' "$D" "$*" "$N"; }
warn() { printf '%s!%s %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '%s✗ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }

# read from the terminal even when the script arrives through a pipe
ask() {
  local prompt="$1" default="${2:-}" answer=""
  if [ "${ASSUME_YES:-}" = "1" ] || ! { [ -r /dev/tty ] && [ -w /dev/tty ]; } 2>/dev/null; then printf '%s' "$default"; return; fi
  if [ -n "$default" ]; then printf '%s %s[%s]%s ' "$prompt" "$D" "$default" "$N" > /dev/tty; else printf '%s ' "$prompt" > /dev/tty; fi
  IFS= read -r answer < /dev/tty || true
  printf '%s' "${answer:-$default}"
}
yes_no() { case "$(ask "$1 (y/n)" "${2:-y}")" in y|Y|yes|Yes) return 0 ;; *) return 1 ;; esac; }
random() { LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "${1:-24}" || true; }
have() { command -v "$1" >/dev/null 2>&1; }
fetch() { # url -> stdout
  if have curl; then curl -fsSL --retry 2 "$1"; elif have wget; then wget -qO- "$1"; else die "Neither curl nor wget is installed."; fi
}

banner() {
  say ""
  say "${A}${B}  Enodia${N} ${D}· a dashboard for Traefik${N}"
  say "${D}  https://github.com/${REPO}${N}"
  say ""
}

default_dir() {
  if [ -n "${ENODIA_DIR:-}" ]; then printf '%s' "$ENODIA_DIR"
  elif [ "$(id -u)" = "0" ]; then printf '/opt/enodia'
  else printf '%s/enodia' "$HOME"; fi
}

# ── docker helpers ────────────────────────────────────────────────────────────

docker_ok() { have docker && docker info >/dev/null 2>&1; }
compose_cmd() {
  if docker compose version >/dev/null 2>&1; then COMPOSE=(docker compose)
  elif have docker-compose; then COMPOSE=(docker-compose)
  else die "Docker Compose is missing: https://docs.docker.com/compose/install/"; fi
}
dc() { (cd "$DIR" && "${COMPOSE[@]}" -p enodia "$@"); }

wait_healthy() {
  local i status
  for i in $(seq 1 60); do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' enodia 2>/dev/null || true)"
    [ "$status" = "healthy" ] && return 0
    sleep 2
  done
  return 1
}
image_version() { docker exec enodia node -p "require('/app/package.json').version" 2>/dev/null || printf '?'; }

# Ask Traefik what it is, from inside the Enodia image, on the network it will share.
# Sets DETECT_OK, TRAEFIK_API_URL, TRAEFIK_VERSION, PROVIDERS, TLS_ENTRYPOINT, RESOLVERS, METRICS_URL...
detect() { # network target...
  local net="$1" t out; shift
  DETECT_OK=0
  for t in "$@"; do
    [ -n "$t" ] || continue
    out="$(docker run --rm --network "$net" --entrypoint node "${IMAGE}:${TAG}" server/detect.mjs "$t" 2>/dev/null || true)"
    # only KEY='value' lines with safe characters are taken in
    eval "$(printf '%s\n' "$out" | grep -E "^[A-Z_]+='[A-Za-z0-9:/._,@+-]*'$" || true)"
    if [ "${DETECT_OK:-0}" = "1" ]; then return 0; fi
  done
  return 1
}

port_busy() { # port
  if have ss; then ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"
  elif have netstat; then netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"
  else return 1; fi
}

# Traefik's settings given as flags or TRAEFIK_* variables, one --key=value per line, keys lowercased.
container_settings() { # container
  docker inspect -f '{{range .Args}}{{println .}}{{end}}{{range .Config.Cmd}}{{println .}}{{end}}{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null \
    | sed -e 's/^TRAEFIK_\([A-Za-z0-9_]*\)=/--\1=/' \
    | awk -F= 'BEGIN { OFS = "=" } /^--/ { k = tolower($1); gsub(/_/, ".", k); $1 = k; print }'
}
setting() { # container key -> value
  container_settings "$1" | grep -i "^--$2=" | head -n1 | cut -d= -f2- || true
}

# The access log of a Traefik container: its path (flags or env first, then its config file) and the
# volume or host directory that holds it, so Enodia can mount the same directory read-only.
find_access_log() { # container
  local c="$1" cfg path="" mounts src dst type f
  LOG_MOUNT=""; LOG_PATH=""; LOG_VOLUME=""; LOG_DIR_IN_TRAEFIK=""
  path="$(setting "$c" accesslog.filepath)"
  if [ -z "$path" ]; then
    cfg="$(setting "$c" configfile)"
    for f in $cfg /etc/traefik/traefik.yml /etc/traefik/traefik.yaml /etc/traefik/traefik.toml /traefik.yml /traefik.yaml /traefik.toml; do
      path="$(docker exec "$c" cat "$f" 2>/dev/null | awk '
        { l = tolower($0) }
        l ~ /^[[:space:]]*\[accesslog\][[:space:]]*$/ { inlog = 2; next }
        l ~ /^accesslog:[[:space:]]*$/ { inlog = 1; next }
        inlog && l ~ /^[[:space:]]*filepath[[:space:]]*[:=]/ {
          sub(/^[^:=]*[:=][[:space:]]*/, ""); sub(/[[:space:]]+#.*$/, ""); gsub(/["'\''[:space:]]/, ""); print; exit
        }
        inlog == 1 && /^[^[:space:]#]/ { inlog = 0 }
        inlog == 2 && /^[[:space:]]*\[/ { inlog = 0 }' || true)"
      if [ -n "$path" ]; then break; fi
    done
  fi
  [ -n "$path" ] || return 1
  case "$path" in /*) ;; *) path="/${path#./}" ;; esac # relative paths start at Traefik's working directory, / in the image
  mounts="$(docker inspect -f '{{range .Mounts}}{{.Type}}|{{if eq .Type "volume"}}{{.Name}}{{else}}{{.Source}}{{end}}|{{.Destination}}{{println}}{{end}}' "$c")"
  while IFS='|' read -r type src dst; do
    [ -n "$dst" ] || continue
    case "$path" in
      "$dst"/*)
        if [ "$type" = "volume" ]; then LOG_VOLUME="$src"; LOG_MOUNT="traefik-logs:/traefik-logs:ro"
        else LOG_MOUNT="${src}:/traefik-logs:ro"; fi
        LOG_PATH="/traefik-logs/${path#"$dst"/}"
        return 0 ;;
    esac
  done <<< "$mounts"
  LOG_DIR_IN_TRAEFIK="$(dirname "$path")"
  return 1
}

traefik_containers() { # docker ps flags...
  docker ps "$@" --format '{{.Names}}\t{{.Image}}' | awk -F'\t' 'tolower($2) ~ /(^|\/)traefik(:|@|$)/ { print $1 }'
}

pick_traefik() {
  local list n
  list="$(traefik_containers)"
  n="$(printf '%s' "$list" | grep -c . || true)"
  if [ "$n" -gt 1 ]; then
    say "Traefik containers on this machine:" >&2
    printf '%s\n' "$list" | sed 's/^/  - /' >&2
    ask 'Which one should Enodia watch?' "$(printf '%s\n' "$list" | head -n1)"
  else
    printf '%s' "$list"
  fi
}

# ── files ─────────────────────────────────────────────────────────────────────

write_env() {
  umask 077
  {
    say "# Enodia settings. After a change: ${RESTART_HINT}"
    say "ENODIA_VERSION=${TAG}"
    say "TRAEFIK_API_URL=${API_URL}"
    if [ -n "${METRICS_URL:-}" ]; then say "TRAEFIK_METRICS_URL=${METRICS_URL}"; fi
    if [ -n "${LOG_PATH:-}" ]; then say "TRAEFIK_ACCESS_LOG=${LOG_PATH}"; fi
    say "ENODIA_PASSWORD=${PASSWORD}"
    say "ENODIA_SECRET=$(random 48)"
    say "ENODIA_INSTANCE_NAME=${NAME}"
    say "ENODIA_INSTALL=script"
    if [ "$MODE" = "node" ]; then say "ENODIA_DATA_DIR=${DIR}/data"; fi
    if [ "$MODE" = "node" ] || [ "$MODE" = "host" ]; then say "PORT=${PORT}"; say "HOST=127.0.0.1"; fi
    if [ -n "${CS_KEY:-}" ]; then say "CROWDSEC_LAPI_URL=${CS_URL}"; say "CROWDSEC_BOUNCER_KEY=${CS_KEY}"; fi
  } > "$DIR/.env"
  chmod 600 "$DIR/.env"
  { printf 'MODE=%s\n' "$MODE"; if [ -n "${CS_KEY:-}" ]; then printf 'CROWDSEC=%s\nBOUNCER=%s\n' "$CS_CONTAINER" "$CS_BOUNCER"; fi; } > "$DIR/.enodia-install"
}

# CrowdSec next to Traefik: with a bouncer key of its own Enodia shows who is banned. A bouncer key
# can only read decisions; the installer asks before creating one.
find_crowdsec() {
  local net port
  CS_KEY=""; CS_URL=""; CS_NETWORK=""; CS_BOUNCER=""
  CS_CONTAINER="$(docker ps --format '{{.Names}}\t{{.Image}}' | awk -F'\t' 'tolower($2) ~ /crowdsecurity\/crowdsec(:|@|$)/ { print $1; exit }')"
  [ -n "$CS_CONTAINER" ] || return 0
  ok "CrowdSec container: ${B}${CS_CONTAINER}${N}"
  if [ "$MODE" = "host" ]; then
    port="$(docker port "$CS_CONTAINER" 8080/tcp 2>/dev/null | head -n1 | sed 's/.*://')"
    if [ -z "$port" ]; then note "Its API is not published on this machine, so Enodia on the host network cannot read its bans."; return 0; fi
    CS_URL="http://127.0.0.1:${port}"
  else
    net="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' "$CS_CONTAINER" | grep -vE '^(host|none|bridge)$' | head -n1 || true)"
    if [ -z "$net" ]; then note "CrowdSec is only on Docker's default network: put it on a named network to show its bans in Enodia."; return 0; fi
    [ "$net" = "$NETWORK" ] || CS_NETWORK="$net"
    CS_URL="http://${CS_CONTAINER}:8080"
  fi
  yes_no "Show CrowdSec's bans in Enodia? (adds a read-only bouncer key)" y || { CS_URL=""; CS_NETWORK=""; return 0; }
  CS_BOUNCER="enodia-$(random 6 | tr 'A-Z' 'a-z')"
  CS_KEY="$(docker exec "$CS_CONTAINER" cscli bouncers add "$CS_BOUNCER" -o raw 2>/dev/null | tail -n1 | tr -d '\r[:space:]')"
  if [ -z "$CS_KEY" ]; then
    warn "Could not create a bouncer key. By hand: docker exec ${CS_CONTAINER} cscli bouncers add enodia"
    CS_URL=""; CS_NETWORK=""; CS_BOUNCER=""
    return 0
  fi
  ok "Bouncer key ${CS_BOUNCER} created; Enodia reads ${CS_URL}"
}

router_labels() { # indent
  local i="$1"
  say "${i}- traefik.enable=true"
  say "${i}- traefik.docker.network=${NETWORK}"
  if [ "$MODE" = "swarm" ]; then say "${i}- traefik.swarm.network=${NETWORK}"; fi
  say "${i}- traefik.http.routers.enodia.rule=Host(\`${DOMAIN}\`)"
  if [ -n "${TLS_ENTRYPOINT:-}" ]; then
    say "${i}- traefik.http.routers.enodia.entrypoints=${TLS_ENTRYPOINT}"
    say "${i}- traefik.http.routers.enodia.tls=true"
    if [ -n "${RESOLVER:-}" ]; then say "${i}- traefik.http.routers.enodia.tls.certresolver=${RESOLVER}"; fi
  elif [ -n "${HTTP_ENTRYPOINT:-}" ]; then
    say "${i}- traefik.http.routers.enodia.entrypoints=${HTTP_ENTRYPOINT}"
  fi
  say "${i}- traefik.http.services.enodia.loadbalancer.server.port=3000"
}

# For a Traefik that does not read Docker labels: the same route for its file provider.
write_file_route() { # upstream-url
  {
    say "# Route for Enodia. Put this file in the directory Traefik's file provider watches."
    say "http:"
    say "  routers:"
    say "    enodia:"
    say "      rule: \"Host(\`${DOMAIN}\`)\""
    if [ -n "${TLS_ENTRYPOINT:-}" ]; then
      say "      entryPoints: [${TLS_ENTRYPOINT}]"
      if [ -n "${RESOLVER:-}" ]; then say "      tls: { certResolver: ${RESOLVER} }"; else say "      tls: {}"; fi
    elif [ -n "${HTTP_ENTRYPOINT:-}" ]; then
      say "      entryPoints: [${HTTP_ENTRYPOINT}]"
    fi
    say "      service: enodia"
    say "  services:"
    say "    enodia:"
    say "      loadBalancer:"
    say "        servers:"
    say "          - url: \"$1\""
  } > "$DIR/enodia-route.yml"
}

compose_enodia() {
  say "  enodia:"
  say "    image: ${IMAGE}:\${ENODIA_VERSION:-latest}"
  say "    container_name: enodia"
  say "    restart: unless-stopped"
  say "    env_file: .env"
  say "    volumes:"
  say "      - enodia-data:/data"
  if [ -n "${LOG_MOUNT:-}" ]; then say "      - ${LOG_MOUNT}"; fi
  if [ "$MODE" = "host" ]; then
    say "    network_mode: host"
    return
  fi
  if [ -n "${CS_NETWORK:-}" ]; then say "    networks: [traefik, crowdsec]"; else say "    networks: [traefik]"; fi
  if [ "$ROUTE" = "labels" ]; then
    say "    labels:"
    router_labels "      "
  else
    say "    ports:"
    say "      - \"127.0.0.1:${PORT}:3000\""
  fi
}

write_compose_existing() {
  {
    say "# Enodia next to an existing Traefik, written by install.sh."
    say "# Update: curl -fsSL ${RAW} | bash -s -- update"
    say "services:"
    compose_enodia
    if [ "$MODE" != "host" ]; then
      say ""; say "networks:"; say "  traefik:"; say "    name: ${NETWORK}"; say "    external: true"
      if [ -n "${CS_NETWORK:-}" ]; then say "  crowdsec:"; say "    name: ${CS_NETWORK}"; say "    external: true"; fi
    fi
    say ""; say "volumes:"; say "  enodia-data:"
    if [ -n "${LOG_VOLUME:-}" ]; then say "  traefik-logs:"; say "    name: ${LOG_VOLUME}"; say "    external: true"; fi
  } > "$DIR/docker-compose.yml"
}

write_compose_stack() {
  local https="$1"
  {
    say "# Traefik and Enodia together, written by install.sh."
    say "# Other containers join the 'traefik' network and get routed with labels."
    say "# Update Enodia: curl -fsSL ${RAW} | bash -s -- update"
    say "services:"
    say "  traefik:"
    say "    image: traefik:v3.6"
    say "    container_name: traefik"
    say "    restart: unless-stopped"
    say "    command:"
    say "      - --api.insecure=true                       # the API on :8080, never published"
    say "      - --providers.docker=true"
    say "      - --providers.docker.exposedbydefault=false"
    say "      - --providers.docker.network=traefik"
    say "      - --entrypoints.web.address=:80"
    say "      - --entrypoints.websecure.address=:443"
    if [ "$https" = "1" ]; then
      say "      - --entrypoints.web.http.redirections.entrypoint.to=websecure"
      say "      - --entrypoints.web.http.redirections.entrypoint.scheme=https"
      say "      - --certificatesresolvers.letsencrypt.acme.tlschallenge=true"
      say "      - --certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json"
      if [ -n "${ACME_EMAIL:-}" ]; then say "      - --certificatesresolvers.letsencrypt.acme.email=${ACME_EMAIL}"; fi
    fi
    say "      - --metrics.prometheus=true"
    say "      - --metrics.prometheus.addRoutersLabels=true"
    say "      - --accesslog=true"
    say "      - --accesslog.format=json"
    say "      - --accesslog.filepath=/logs/access.log"
    say "      - --accesslog.fields.headers.names.User-Agent=keep"
    say "      - --accesslog.fields.headers.names.Cf-Ipcountry=keep"
    say "    ports:"
    say "      - \"80:80\""
    say "      - \"443:443\""
    say "    volumes:"
    say "      - /var/run/docker.sock:/var/run/docker.sock:ro"
    say "      - letsencrypt:/letsencrypt"
    say "      - traefik-logs:/logs"
    say "    networks: [traefik]"
    say ""
    compose_enodia
    say "    depends_on: [traefik]"
    say ""
    say "networks:"
    say "  traefik:"
    say "    name: traefik"
    say ""
    say "volumes:"
    say "  enodia-data:"
    say "  letsencrypt:"
    say "  traefik-logs:"
  } > "$DIR/docker-compose.yml"
}

# docker stack deploy reads neither .env for the tag nor container_name, so the tag is written in.
write_swarm_stack() {
  {
    say "# Enodia as a Swarm stack next to Traefik, written by install.sh."
    say "#   docker stack deploy -c enodia-stack.yml enodia"
    say "# Update: curl -fsSL ${RAW} | bash -s -- update"
    say "services:"
    say "  enodia:"
    say "    image: ${IMAGE}:${TAG}"
    say "    env_file: .env"
    say "    volumes:"
    say "      - enodia-data:/data"
    say "    networks: [traefik]"
    if [ "$ROUTE" != "labels" ]; then
      say "    ports:"
      say "      - target: 3000"
      say "        published: ${PORT}"
      say "        mode: host"
    fi
    say "    deploy:"
    say "      replicas: 1"
    if [ "$ROUTE" = "labels" ]; then
      say "      labels:"
      router_labels "        "
    fi
    say ""
    say "networks:"
    say "  traefik:"
    say "    name: ${NETWORK}"
    say "    external: true"
    say ""
    say "volumes:"
    say "  enodia-data:"
  } > "$DIR/enodia-stack.yml"
}

# ── install ───────────────────────────────────────────────────────────────────

common_questions() { # ask-domain
  if [ "$1" = "1" ]; then
    DOMAIN="${ENODIA_DOMAIN-$(ask 'Domain to serve Enodia on through Traefik (empty: only on this machine):' '')}"
  else
    DOMAIN=""
  fi
  PASSWORD="${ENODIA_PASSWORD:-}"; GENERATED=""
  while :; do
    if [ -z "$PASSWORD" ]; then PASSWORD="$(ask 'Login password (empty: generate one):' '')"; fi
    if [ -z "$PASSWORD" ]; then PASSWORD="$(random 20)"; GENERATED=1; break; fi
    case "$PASSWORD" in
      *[\ \$\'\"\\\#\`]*)
        if [ "${ASSUME_YES:-}" = "1" ]; then die "ENODIA_PASSWORD may not contain spaces or \$ ' \" \\ # \`."; fi
        warn "Use letters, digits and symbols other than space \$ ' \" \\ # \`."; PASSWORD="" ;;
      *) break ;;
    esac
  done
  NAME="$(ask 'A name for this Traefik, shown in the header:' "$(hostname 2>/dev/null || echo traefik)")"
  NAME="$(printf '%s' "$NAME" | tr ' ' '-' | tr -cd 'A-Za-z0-9._-')"
}

finish() {
  say ""
  if [ "$ROUTE" = "labels" ]; then say "  ${B}Open${N}      http${TLS_ENTRYPOINT:+s}://${DOMAIN}"
  elif [ "$MODE" = "swarm" ]; then say "  ${B}Open${N}      http://this-server:${PORT}  ${D}(published on every interface of the node running it)${N}"
  else say "  ${B}Open${N}      http://127.0.0.1:${PORT}  ${D}(from your computer: ssh -L ${PORT}:127.0.0.1:${PORT} this-server)${N}"; fi
  if [ "$ROUTE" = "file" ]; then
    say "  ${B}Route${N}     ${DIR}/enodia-route.yml ${D}(copy it where Traefik's file provider looks, for ${DOMAIN})${N}"
  fi
  if [ -n "$GENERATED" ]; then say "  ${B}Password${N}  ${A}${PASSWORD}${N}  ${D}(shown once, kept in ${DIR}/.env)${N}"
  else say "  ${B}Password${N}  the one you chose (kept in ${DIR}/.env)"; fi
  say "  ${B}Settings${N}  ${DIR}/.env"
  say "  ${B}Update${N}    curl -fsSL ${RAW} | bash -s -- update"
  say ""
}

traefik_report() {
  ok "Traefik ${TRAEFIK_VERSION:-?} API: ${B}${API_URL}${N}"
  if [ -n "${METRICS_URL:-}" ]; then
    ok "Metrics: ${METRICS_URL}"
    if [ "${ROUTER_METRICS:-1}" = "0" ]; then note "Tip: --metrics.prometheus.addRoutersLabels=true adds traffic per router."; fi
  else
    note "Live traffic needs Prometheus metrics: --metrics.prometheus=true --metrics.prometheus.addRoutersLabels=true"
  fi
  if [ "${ACCESSLOG:-0}" = "1" ] && [ -n "${ACCESSLOG_FORMAT:-}" ] && [ "$ACCESSLOG_FORMAT" != "json" ]; then
    note "The access log is in ${ACCESSLOG_FORMAT} format: --accesslog.format=json gives Enodia every field."
  fi
}

api_missing() { # where
  warn "Traefik's API does not answer${1:+ on $1}. Enable it; it stays on the internal port:"
  note "flags:        --api.insecure=true"
  note "traefik.yml:  api: { insecure: true }"
  note "or point Enodia elsewhere: TRAEFIK_API_URL (and TRAEFIK_API_USERNAME / TRAEFIK_API_PASSWORD) in .env"
  yes_no 'Install Enodia anyway and fix this afterwards?' y || exit 1
}

install_docker() {
  local traefik="" mode="${ENODIA_MODE:-}" api_port="" svc="" stopped https=0
  local -a targets=()
  step "Pulling ${IMAGE}:${TAG}"
  docker pull -q "${IMAGE}:${TAG}" >/dev/null || die "Could not pull ${IMAGE}:${TAG}."
  METRICS_URL=""; LOG_MOUNT=""; LOG_PATH=""; LOG_VOLUME=""; LOG_DIR_IN_TRAEFIK=""; RESOLVERS=""; RESOLVER=""
  TLS_ENTRYPOINT=""; HTTP_ENTRYPOINT=""; NETWORK=""; PROVIDERS=""

  if [ -z "$mode" ] || [ "$mode" = "docker" ] || [ "$mode" = "swarm" ]; then
    traefik="${TRAEFIK_CONTAINER:-$(pick_traefik)}"
    if [ -n "$traefik" ]; then
      svc="$(docker inspect -f '{{ index .Config.Labels "com.docker.swarm.service.name" }}' "$traefik" 2>/dev/null || true)"
      if [ -n "$svc" ]; then mode="swarm"; else mode="docker"; fi
    else
      stopped="$(traefik_containers -a --filter status=exited | head -n1)"
      if [ -n "$stopped" ]; then warn "The Traefik container ${stopped} is stopped. Start it (docker start ${stopped}) and run this again, or go on without it."; fi
      if [ -n "$mode" ]; then die "No running Traefik container found."; fi
    fi
  fi
  if [ -z "$mode" ] && detect host "${TRAEFIK_API_URL:-127.0.0.1}"; then mode="host"; fi
  if [ -z "$mode" ]; then
    warn "No Traefik found on this machine."
    say "  1) Set up Traefik and Enodia together ${D}(Traefik on ports 80 and 443, ready for your other containers)${N}"
    say "  2) My Traefik runs somewhere else: I will type its API address"
    say "  3) Cancel"
    case "$(ask 'Choose:' '1')" in
      1) mode="stack" ;;
      2) TRAEFIK_API_URL="$(ask 'Traefik API address (e.g. http://10.0.0.5:8080):' '')"; mode="host" ;;
      *) say "Nothing changed."; exit 0 ;;
    esac
  fi
  MODE="$mode"

  if [ "$MODE" = "docker" ] || [ "$MODE" = "swarm" ]; then
    ok "Traefik container: ${B}${traefik}${N} ($(docker inspect -f '{{.Config.Image}}' "$traefik" | sed 's/@sha256:.*//'))${svc:+, Swarm service ${svc}}"
    api_port="$(setting "$traefik" entrypoints.traefik.address | sed -n 's/.*:\([0-9][0-9]*\).*/\1/p')"
    NETWORK="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' "$traefik" | grep -vE '^(host|none|bridge|ingress|docker_gwbridge)$' | head -n1 || true)"
    if [ -z "$NETWORK" ] && [ "$MODE" = "swarm" ]; then die "Traefik's Swarm service is on no overlay network Enodia could join."; fi
    if [ -z "$NETWORK" ]; then
      if [ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$traefik")" = "host" ]; then
        MODE="host"; ok "Traefik uses the host network: so will Enodia"
      else
        NETWORK="traefik"
        warn "Traefik is only on Docker's default network, where containers cannot find each other by name."
        step "Creating the network '${NETWORK}' and connecting ${traefik} to it"
        docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null
        docker network connect "$NETWORK" "$traefik" 2>/dev/null || true
      fi
    fi
  fi

  case "$MODE" in
    docker|swarm)
      ok "Shared network: ${B}${NETWORK}${N}"
      local name="$traefik"; [ "$MODE" = "swarm" ] && name="$svc"
      if [ -n "${TRAEFIK_API_URL:-}" ]; then targets=("$TRAEFIK_API_URL")
      else
        if [ -n "$api_port" ]; then targets+=("http://${name}:${api_port}"); fi
        targets+=("$name")
      fi
      # a one-off container joins a Swarm overlay only when it is attachable; the service name is the fallback
      if ! detect "$NETWORK" "${targets[@]}"; then
        if [ "$MODE" = "docker" ]; then api_missing "$name"; fi
        TRAEFIK_API_URL="${TRAEFIK_API_URL:-http://${name}:${api_port:-8080}}"
      fi
      ;;
    host)
      detect host "${TRAEFIK_API_URL:-127.0.0.1}" || { api_missing "${TRAEFIK_API_URL:-127.0.0.1:8080}"; TRAEFIK_API_URL="${TRAEFIK_API_URL:-http://127.0.0.1:8080}"; }
      ok "Enodia uses the host network and listens on 127.0.0.1:${PORT}"
      ;;
    stack)
      for p in 80 443; do
        if port_busy "$p"; then die "Port ${p} is already in use (another web server?). Stop it, or install your own Traefik first."; fi
      done
      ;;
  esac
  if [ -n "$traefik" ] && { [ "$MODE" = "docker" ] || [ "$MODE" = "host" ]; }; then
    if find_access_log "$traefik"; then ok "Access log shared read-only (${LOG_PATH})"
    elif [ -n "$LOG_DIR_IN_TRAEFIK" ]; then note "Traefik writes its access log to ${LOG_DIR_IN_TRAEFIK}, which is not on a volume: mount one there to share it with Enodia."
    else note "For the log explorer: --accesslog=true --accesslog.format=json --accesslog.filepath=/logs/access.log, on a volume."; fi
  fi

  API_URL="${TRAEFIK_API_URL:-http://traefik:8080}"
  RESOLVER="${RESOLVERS%%,*}"
  if [ "$MODE" != "stack" ]; then traefik_report; fi

  CS_KEY=""; CS_NETWORK=""
  if [ "$MODE" = "docker" ] || [ "$MODE" = "host" ]; then find_crowdsec; fi

  say ""
  common_questions 1
  DIR="$(default_dir)"
  mkdir -p "$DIR"

  # how Traefik reaches Enodia on the domain: labels when it reads them, a file-provider route otherwise
  ROUTE="none"
  if [ -n "$DOMAIN" ]; then
    if [ "$MODE" = "stack" ]; then ROUTE="labels"
    elif [ "$MODE" != "host" ] && printf '%s' "$PROVIDERS" | grep -qiE 'docker|swarm'; then ROUTE="labels"
    else ROUTE="file"; fi
  fi

  case "$MODE" in
    stack)
      NETWORK="traefik"; HTTP_ENTRYPOINT="web"
      if [ -n "$DOMAIN" ]; then
        https=1; TLS_ENTRYPOINT="websecure"; RESOLVER="letsencrypt"
        ACME_EMAIL="${ACME_EMAIL-$(ask 'E-mail for Let'\''s Encrypt (optional):' '')}"
      fi
      API_URL="http://traefik:8080"; METRICS_URL=""; LOG_MOUNT="traefik-logs:/traefik-logs:ro"; LOG_PATH="/traefik-logs/access.log"
      write_compose_stack "$https"
      ;;
    swarm) write_swarm_stack ;;
    *) write_compose_existing ;;
  esac
  if [ "$ROUTE" = "file" ]; then
    if [ "$MODE" = "host" ]; then write_file_route "http://127.0.0.1:${PORT}"; else write_file_route "http://enodia:3000"; fi
  fi

  if [ "$MODE" = "swarm" ]; then
    RESTART_HINT="cd ${DIR} && docker stack deploy -c enodia-stack.yml enodia"
    write_env
    step "Deploying the stack enodia"
    (cd "$DIR" && docker stack deploy -c enodia-stack.yml enodia >/dev/null)
    ok "Stack deployed (docker service ps enodia_enodia)"
  else
    compose_cmd
    RESTART_HINT="cd ${DIR} && ${COMPOSE[*]} -p enodia up -d"
    write_env
    step "Starting in ${DIR}"
    dc up -d --remove-orphans
    if wait_healthy; then ok "Enodia $(image_version) is running and reaches Traefik."
    else warn "Enodia started but does not reach Traefik yet. See: docker logs enodia"; fi
  fi
  finish
}

# ── node (no docker) ──────────────────────────────────────────────────────────

node_ok() { have node && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 20 ]; }

latest_tag() { fetch "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1 || true; }

download_app() { # dir tag
  local dir="$1" tag="$2" url tmp
  if [ "$tag" = "latest" ]; then tag="$(latest_tag)"; fi
  if [ -n "$tag" ] && [ "$tag" != "latest" ]; then url="https://codeload.github.com/${REPO}/tar.gz/refs/tags/${tag}"
  else url="https://codeload.github.com/${REPO}/tar.gz/refs/heads/main"; fi
  tmp="$(mktemp -d)"
  fetch "$url" | tar -xz -C "$tmp" --strip-components=1 || die "Download failed: ${url}"
  rm -rf "$dir/app.new" && mkdir -p "$dir/app.new"
  cp -r "$tmp/server" "$tmp/public" "$tmp/package.json" "$dir/app.new/"
  rm -rf "$tmp" "$dir/app.old"
  if [ -d "$dir/app" ]; then mv "$dir/app" "$dir/app.old"; fi
  mv "$dir/app.new" "$dir/app"
  rm -rf "$dir/app.old"
}

install_node() {
  local tmp
  MODE="node"; ROUTE="none"; TLS_ENTRYPOINT=""
  ok "Node.js $(node -v), no Docker: Enodia runs as a service"
  DETECT_OK=0
  tmp="$(mktemp -d)"
  if fetch "https://raw.githubusercontent.com/${REPO}/main/server/detect.mjs" > "$tmp/detect.mjs" 2>/dev/null; then
    eval "$(node "$tmp/detect.mjs" "${TRAEFIK_API_URL:-127.0.0.1}" 2>/dev/null | grep -E "^[A-Z_]+='[A-Za-z0-9:/._,@+-]*'$" || true)"
  fi
  rm -rf "$tmp"
  if [ "${DETECT_OK:-0}" != "1" ]; then
    TRAEFIK_API_URL="$(ask 'Traefik API address (e.g. http://127.0.0.1:8080):' "${TRAEFIK_API_URL:-http://127.0.0.1:8080}")"
  fi
  API_URL="$TRAEFIK_API_URL"; LOG_PATH=""
  if [ "${DETECT_OK:-0}" = "1" ]; then traefik_report; fi
  note "The access log is picked up from /var/log/traefik/access.log; anywhere else, set TRAEFIK_ACCESS_LOG in .env."
  say ""
  common_questions 0
  DIR="$(default_dir)"
  mkdir -p "$DIR/data"
  step "Downloading Enodia (${TAG}) into ${DIR}/app"
  download_app "$DIR" "$TAG"
  RESTART_HINT="systemctl restart enodia"
  write_env
  if [ "$(id -u)" = "0" ] && have systemctl; then
    id enodia >/dev/null 2>&1 || useradd --system --home "$DIR" --shell /usr/sbin/nologin enodia 2>/dev/null || true
    chown -R enodia: "$DIR/data" "$DIR/.env" 2>/dev/null || true
    cat > /etc/systemd/system/enodia.service <<UNIT
[Unit]
Description=Enodia, a dashboard for Traefik
After=network-online.target
Wants=network-online.target

[Service]
User=enodia
WorkingDirectory=${DIR}/app
EnvironmentFile=${DIR}/.env
ExecStart=$(command -v node) server/index.mjs
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=${DIR}/data

[Install]
WantedBy=multi-user.target
UNIT
    systemctl daemon-reload
    systemctl enable --now enodia >/dev/null
    ok "Service enodia started (systemctl status enodia)"
  else
    note "Start it with:  cd ${DIR}/app && node --env-file=../.env server/index.mjs"
    note "Keep it running with systemd, pm2 or any process supervisor."
  fi
  finish
}

install() {
  banner
  local existing
  existing="$(existing_dir)"
  if [ -n "$existing" ]; then warn "Enodia is already installed in ${existing}: updating it."; update; return; fi
  if [ "${ENODIA_MODE:-}" = "node" ]; then node_ok || die "Node.js 20 or newer is needed."; install_node; return; fi
  if docker_ok; then install_docker
  elif node_ok; then install_node
  elif have docker; then die "Docker is installed but this user cannot use it. Run with sudo, or join the docker group."
  else die "Install Docker (https://docs.docker.com/engine/install/) or Node.js 20+, then run this again."; fi
}

# ── update / uninstall ────────────────────────────────────────────────────────

existing_dir() {
  local d
  if docker_ok; then
    d="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' enodia 2>/dev/null || true)"
    if [ -n "$d" ] && [ -f "$d/.enodia-install" ]; then printf '%s' "$d"; return; fi
  fi
  d="$(default_dir)"
  if [ -f "$d/.enodia-install" ]; then printf '%s' "$d"; fi
}

install_mode() { sed -n 's/^MODE=//p' "$1/.enodia-install" 2>/dev/null | head -n1; }

update() {
  local before="?" after="?"
  DIR="$(existing_dir)"
  [ -n "$DIR" ] || die "No Enodia installation found. Install it first, or set ENODIA_DIR."
  MODE="$(install_mode "$DIR")"
  if [ -n "${ENODIA_VERSION:-}" ]; then sed -i.bak "s/^ENODIA_VERSION=.*/ENODIA_VERSION=${ENODIA_VERSION}/" "$DIR/.env" && rm -f "$DIR/.env.bak"; fi
  TAG="$(sed -n 's/^ENODIA_VERSION=//p' "$DIR/.env" 2>/dev/null | head -n1)"; TAG="${TAG:-latest}"
  case "$MODE" in
    node)
      before="$(node -p "require('${DIR}/app/package.json').version" 2>/dev/null || echo '?')"
      step "Updating Enodia in ${DIR} (now ${before})"
      download_app "$DIR" "$TAG"
      after="$(node -p "require('${DIR}/app/package.json').version" 2>/dev/null || echo '?')"
      if have systemctl && systemctl is-enabled enodia >/dev/null 2>&1; then systemctl restart enodia; fi
      ;;
    swarm)
      docker_ok || die "Cannot talk to Docker."
      step "Updating the Swarm service enodia_enodia to ${IMAGE}:${TAG}"
      sed -i.bak "s#^    image: ${IMAGE}:.*#    image: ${IMAGE}:${TAG}#" "$DIR/enodia-stack.yml" && rm -f "$DIR/enodia-stack.yml.bak"
      docker service update --quiet --with-registry-auth --image "${IMAGE}:${TAG}" enodia_enodia >/dev/null
      ok "Updated. docker service ps enodia_enodia shows the new task."
      return
      ;;
    *)
      docker_ok || die "Cannot talk to Docker."
      compose_cmd
      before="$(image_version)"
      step "Updating Enodia in ${DIR} (now ${before})"
      dc pull -q enodia
      dc up -d enodia
      wait_healthy || warn "The new version is not healthy yet. See: docker logs enodia"
      after="$(image_version)"
      docker image prune -f --filter "label=org.opencontainers.image.title=Enodia" >/dev/null 2>&1 || true
      ;;
  esac
  if [ "$before" = "$after" ]; then ok "Already on the latest version (${after})."; else ok "Updated ${before} → ${B}${after}${N}"; fi
}

uninstall() {
  DIR="$(existing_dir)"
  [ -n "$DIR" ] || die "No Enodia installation found."
  MODE="$(install_mode "$DIR")"
  step "Removing Enodia from ${DIR}"
  case "$MODE" in
    node)
      if have systemctl && [ -f /etc/systemd/system/enodia.service ]; then
        systemctl disable --now enodia >/dev/null 2>&1 || true
        rm -f /etc/systemd/system/enodia.service
        systemctl daemon-reload
      fi
      ;;
    swarm)
      docker stack rm enodia >/dev/null
      if [ -n "$PURGE" ]; then note "The volume enodia_enodia-data stays on the node that ran Enodia: docker volume rm enodia_enodia-data there."; fi
      ;;
    stack)
      compose_cmd
      warn "This setup includes Traefik: Enodia is removed, Traefik keeps running."
      dc rm -sf enodia
      if [ -n "$PURGE" ]; then docker volume rm enodia_enodia-data >/dev/null 2>&1 || true; fi
      ;;
    *)
      compose_cmd
      if [ -n "$PURGE" ]; then dc down -v; else dc down; fi
      ;;
  esac
  local cs bouncer
  cs="$(sed -n 's/^CROWDSEC=//p' "$DIR/.enodia-install" 2>/dev/null | head -n1)"
  bouncer="$(sed -n 's/^BOUNCER=//p' "$DIR/.enodia-install" 2>/dev/null | head -n1)"
  if [ -n "$cs" ] && [ -n "$bouncer" ] && docker exec "$cs" cscli bouncers delete "$bouncer" >/dev/null 2>&1; then ok "Removed the CrowdSec bouncer key ${bouncer}"; fi
  if [ -n "$PURGE" ] && [ "$MODE" != "stack" ]; then rm -rf "$DIR"; ok "Removed Enodia, its settings and its history."
  elif [ -n "$PURGE" ]; then ok "Enodia and its history removed. ${DIR} stays, since it runs Traefik."
  else ok "Enodia removed. Settings stay in ${DIR}; --purge deletes them too."; fi
}

case "$ACTION" in
  install) install ;;
  update|upgrade) banner; update ;;
  uninstall|remove) uninstall ;;
  help|-h|--help) sed -n '2,26p' "${BASH_SOURCE[0]:-/dev/null}" 2>/dev/null | grep . || say "See https://github.com/${REPO}#install" ;;
esac
