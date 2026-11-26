#!/usr/bin/env bash
# Run Dittoly on this machine in one step.
#
#   ./run.sh                    set up what is missing, then start
#   ./run.sh --ai claude-cli    choose the AI that drafts modules and Flows (skips the question)
#   ./run.sh --rebuild          build the portal and server again before starting
#   ./run.sh --setup-only       do everything except start Dittoly
#   ./run.sh --stop             stop PostgreSQL and RabbitMQ (your data is kept)
#
# What it does, in order, and only what is still missing:
#   1. checks Node.js 26 (switches with nvm when you have it) and Docker with Compose;
#   2. installs the npm packages;
#   3. creates .env from .env.example, with a new encryption key (an existing key is never replaced);
#   4. asks which AI drafts modules and Flows, if none is set — the key you type goes into .env only;
#   5. pulls and starts PostgreSQL and RabbitMQ in Docker (docker-compose.local.yml), and waits for them;
#   6. builds the portal and server;
#   7. starts Dittoly and prints your sign-in link.
#
# Running it again is safe: every step checks first and keeps what you already have.
set -euo pipefail

cd "$(dirname "$0")"

AI_PROVIDERS="claude-cli codex-cli anthropic openai ollama none"
COMPOSE_FILE="docker-compose.local.yml"
ai=""
rebuild=0
start=1

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31mx %s\033[0m\n' "$*" >&2; exit 1; }
note() { printf '  %s\n' "$*"; }

usage() { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --ai) [ $# -ge 2 ] || fail "--ai needs a provider: $AI_PROVIDERS"; ai="$2"; shift 2 ;;
    --ai=*) ai="${1#--ai=}"; shift ;;
    --rebuild) rebuild=1; shift ;;
    --setup-only) start=0; shift ;;
    --stop)
      docker compose -f "$COMPOSE_FILE" down
      echo "PostgreSQL and RabbitMQ stopped. Your data is kept; ./run.sh starts them again."
      exit 0 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1 (see ./run.sh --help)" ;;
  esac
done

if [ -n "$ai" ] && ! printf ' %s ' "$AI_PROVIDERS" | grep -q " $ai "; then
  fail "Unknown AI provider \"$ai\". Choose one of: $AI_PROVIDERS"
fi

# ---------------------------------------------------------------------------------------------- 1. tools
step "Checking Node.js and Docker"

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

if [ "$(node_major)" -lt 26 ]; then
  # nvm is a shell function, so it has to be loaded into this script before it can switch versions.
  nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$nvm_dir/nvm.sh" ]; then
    note "Node.js $(node -v 2>/dev/null || echo 'is missing'); switching with nvm (.nvmrc says $(cat .nvmrc))"
    # shellcheck disable=SC1091
    . "$nvm_dir/nvm.sh"
    nvm install >/dev/null
    nvm use >/dev/null
  fi
fi
if [ "$(node_major)" -lt 26 ]; then
  fail "Dittoly needs Node.js 26 or later (found $(node -v 2>/dev/null || echo none)).
  Node.js 22 cannot enforce the sandbox's network limits, so an older version is not enough.
  Install it from https://nodejs.org, or with nvm: nvm install 26"
fi
note "Node.js $(node -v)"

command -v docker >/dev/null 2>&1 || fail "Docker is not installed. Install Docker Desktop (or Docker Engine with the Compose plugin)."
docker compose version >/dev/null 2>&1 || fail "Docker Compose is missing. Install the Compose v2 plugin (docker compose)."
docker info >/dev/null 2>&1 || fail "Docker is installed but not running. Start Docker Desktop (or the Docker service) and run ./run.sh again."
note "$(docker compose version)"

# ---------------------------------------------------------------------------------------------- 2. packages
# npm ci again only when the lockfile changed since the last install.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  step "Installing npm packages"
  npm ci
fi

# ---------------------------------------------------------------------------------------------- 3. .env
step "Preparing .env"
[ -f .env ] || note "Creating .env from .env.example"
node scripts/setup-local.mjs

# Read and write single settings in .env with the same quoting setup-local.mjs uses.
env_get() {
  node -e '
    const { parseEnv } = require("node:util");
    const v = parseEnv(require("node:fs").readFileSync(".env", "utf8"))[process.argv[1]];
    process.stdout.write((v ?? "").trim());
  ' "$1"
}
env_set() {
  # The value is passed on stdin, never as an argument, so a key never shows up in the process list.
  printf '%s' "$2" | node -e '
    const fs = require("node:fs");
    const name = process.argv[1];
    const value = fs.readFileSync(0, "utf8");
    let source = fs.readFileSync(".env", "utf8");
    const line = `${name}=${JSON.stringify(value)}`;
    // A real setting is replaced first; failing that, the commented example line, so it stays where it is.
    const live = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=.*$`, "m");
    const example = new RegExp(`^[ \\t]*#[ \\t]*${name}[ \\t]*=.*$`, "m");
    if (live.test(source)) source = source.replace(live, () => line);
    else if (example.test(source)) source = source.replace(example, () => line);
    else source = `${source.trimEnd()}\n${line}\n`;
    fs.writeFileSync(".env", source, { mode: 0o600 });
  ' "$1"
  chmod 600 .env
}

# ---------------------------------------------------------------------------------------------- 4. AI
step "AI for drafting modules and Flows"

ask_secret() {
  local prompt="$1" value=""
  while [ -z "$value" ]; do
    read -r -s -p "  $prompt: " value </dev/tty
    echo >/dev/tty
  done
  printf '%s' "$value"
}

choose_ai() {
  local options=() detected i choice
  # The CLIs you are already signed in to come first: they need no key.
  for cli in claude codex; do
    command -v "$cli" >/dev/null 2>&1 && options+=("$cli-cli")
  done
  command -v ollama >/dev/null 2>&1 && options+=("ollama")
  for p in anthropic openai claude-cli codex-cli ollama none; do
    printf ' %s ' "${options[*]-}" | grep -q " $p " || options+=("$p")
  done
  detected=$( { command -v claude || true; command -v codex || true; command -v ollama || true; } | wc -l | tr -d ' ')
  {
    echo "  No AI is set up yet. Without one, Dittoly works but cannot draft a module or Flow from a description."
    [ "$detected" -gt 0 ] && echo "  Found on this machine: $(for c in claude codex ollama; do command -v $c >/dev/null 2>&1 && printf '%s ' "$c"; done)"
    echo
    i=1
    for p in "${options[@]}"; do
      case "$p" in
        claude-cli) d="Claude Code CLI, with your own login (no key here)" ;;
        codex-cli)  d="OpenAI Codex CLI, with your own login (no key here)" ;;
        anthropic)  d="Anthropic API (asks for ANTHROPIC_API_KEY)" ;;
        openai)     d="OpenAI API (asks for OPENAI_API_KEY)" ;;
        ollama)     d="Ollama, a model running on your machine (asks which model)" ;;
        none)       d="No AI for now (you can run ./run.sh --ai <provider> later)" ;;
      esac
      if [ "$i" = 1 ]; then
        case "$p" in claude-cli|codex-cli|ollama) d="$d  <- recommended, found on this machine" ;; esac
      fi
      printf '  %d) %-11s %s\n' "$i" "$p" "$d"
      i=$((i + 1))
    done
    echo
  } >/dev/tty
  while :; do
    read -r -p "  Type a number and press Enter (just Enter = 1): " choice </dev/tty
    choice="${choice:-1}"
    if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#options[@]}" ]; then
      printf '%s' "${options[$((choice - 1))]}"
      return
    fi
    echo "  Please type a number from 1 to ${#options[@]}." >/dev/tty
  done
}

interactive=0
[ -t 0 ] && [ -r /dev/tty ] && interactive=1

current_ai="$(env_get DITTOLY_AI_PROVIDER)"
if [ -z "$ai" ]; then
  if [ -n "${DITTOLY_AI_PROVIDER:-}" ]; then
    ai="$DITTOLY_AI_PROVIDER"
  elif [ -n "$current_ai" ] && [ "$current_ai" != "none" ]; then
    ai="$current_ai"
  elif [ "$interactive" = 1 ]; then
    ai="$(choose_ai)"
  else
    ai="${current_ai:-none}"
    note "Not asking: no terminal to ask on. Set one with ./run.sh --ai <provider>."
  fi
fi
env_set DITTOLY_AI_PROVIDER "$ai"

# What each provider still needs. A value already in your shell or in .env is used as it is.
case "$ai" in
  anthropic)
    if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "$(env_get ANTHROPIC_API_KEY)" ]; then
      [ "$interactive" = 1 ] || fail "anthropic needs ANTHROPIC_API_KEY: set it in .env or your shell."
      env_set ANTHROPIC_API_KEY "$(ask_secret 'ANTHROPIC_API_KEY (input hidden, saved only in .env)')"
    fi ;;
  openai)
    if [ -z "${OPENAI_API_KEY:-}" ] && [ -z "$(env_get OPENAI_API_KEY)" ]; then
      [ "$interactive" = 1 ] || fail "openai needs OPENAI_API_KEY: set it in .env or your shell."
      env_set OPENAI_API_KEY "$(ask_secret 'OPENAI_API_KEY (input hidden, saved only in .env)')"
    fi ;;
  ollama)
    if [ -z "${DITTOLY_AI_MODEL:-}" ] && [ -z "$(env_get DITTOLY_AI_MODEL)" ]; then
      [ "$interactive" = 1 ] || fail "ollama needs DITTOLY_AI_MODEL (a model you pulled): set it in .env or your shell."
      if command -v ollama >/dev/null 2>&1; then
        echo "  Models pulled on this machine:" >/dev/tty
        ollama list 2>/dev/null | awk 'NR > 1 { print "    " $1 }' >/dev/tty || true
      fi
      model=""
      while [ -z "$model" ]; do read -r -p "  Which model (for example gemma4:12b): " model </dev/tty; done
      env_set DITTOLY_AI_MODEL "$model"
    fi
    if [ -z "${DITTOLY_OLLAMA_URL:-}" ] && [ -z "$(env_get DITTOLY_OLLAMA_URL)" ]; then
      env_set DITTOLY_OLLAMA_URL "http://127.0.0.1:11434"
    fi ;;
  claude-cli)
    command -v claude >/dev/null 2>&1 || note "The claude CLI is not on your PATH yet: install Claude Code and sign in, or drafting will fail." ;;
  codex-cli)
    command -v codex >/dev/null 2>&1 || note "The codex CLI is not on your PATH yet: install it and sign in, or drafting will fail." ;;
esac
case "$ai" in
  anthropic) saved="ANTHROPIC_API_KEY saved in .env (hidden; .env is private to you and never committed)" ;;
  openai)    saved="OPENAI_API_KEY saved in .env (hidden; .env is private to you and never committed)" ;;
  ollama)    saved="model $(env_get DITTOLY_AI_MODEL) at $(env_get DITTOLY_OLLAMA_URL)" ;;
  claude-cli|codex-cli) saved="uses your own ${ai%-cli} login on this machine; no key is stored" ;;
  *)         saved="drafting from a description is off; everything else works" ;;
esac
note "AI: $ai — $saved"
note "Change it any time: ./run.sh --ai <claude-cli|codex-cli|anthropic|openai|ollama|none>"

# ---------------------------------------------------------------------------------------------- 5. services
step "Starting PostgreSQL and RabbitMQ in Docker"
note "First run pulls postgres:16 and rabbitmq:4.2-alpine; later runs reuse them and keep your data."
docker compose -f "$COMPOSE_FILE" up -d --wait

# ---------------------------------------------------------------------------------------------- 6. build
# Build when there is no portal yet, when asked, or when the sources changed since the last build.
stamp="dist/.run-built"
if [ "$rebuild" = 1 ] || [ ! -f dist/web/index.html ] || [ ! -f "$stamp" ] ||
   [ -n "$(find src web package-lock.json -newer "$stamp" -print -quit 2>/dev/null)" ]; then
  step "Building the portal and server"
  npm run build
  touch "$stamp"
fi

# ---------------------------------------------------------------------------------------------- 7. start
if [ "$start" = 0 ]; then
  step "Ready"
  echo "  Everything is set up. Start Dittoly with: npm start   (or ./run.sh)"
  exit 0
fi

step "Starting Dittoly"
cat <<EOF
  Address    http://localhost:$(env_get PORT)  (open the sign-in link it prints below)
  AI         $ai
  Services   PostgreSQL on 127.0.0.1:5433, RabbitMQ on 127.0.0.1:5672 (Docker)
  Settings   .env  (keep the DITTOLY_MASTER_KEY in it safe: it cannot be recovered)
  Stop       Ctrl+C stops Dittoly; ./run.sh --stop stops the services too (your data is kept)

EOF
exec npm start
