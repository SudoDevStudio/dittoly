#!/usr/bin/env bash
# Set up and start Dittoly on this machine: the same as `npx dittoly run`, after switching to Node.js 26 with nvm
# when the current Node.js is older. All options are passed on (./run.sh --help lists them).
set -euo pipefail
cd "$(dirname "$0")"

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

if [ "$(node_major)" -lt 26 ]; then
  nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$nvm_dir/nvm.sh" ]; then
    echo "Node.js $(node -v 2>/dev/null || echo 'is missing'); switching with nvm to $(cat .nvmrc)…"
    # shellcheck disable=SC1091
    . "$nvm_dir/nvm.sh"
    nvm install >/dev/null
    nvm use >/dev/null
  fi
fi
if [ "$(node_major)" -lt 26 ]; then
  echo "Dittoly needs Node.js 26 or later (found $(node -v 2>/dev/null || echo none))." >&2
  echo "Install it from https://nodejs.org, or with nvm: nvm install 26" >&2
  exit 1
fi

exec node bin/dittoly.mjs run "$@"
