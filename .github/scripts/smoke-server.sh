#!/usr/bin/env bash
# Starts compose.server.yml with one image and checks it is fit to ship. Used by the pull-request check and,
# before anything is published, by the release (.github/workflows/release.yml).
#
#   .github/scripts/smoke-server.sh <tag>     runs ghcr.io/sudodevstudio/dittoly:<tag>
#
# Checks: every service healthy, /ready says ready, Caddy serves HTTPS, PostgreSQL and RabbitMQ are not reachable
# from the host, and the first admin can be created. Leaves the stack down either way.
set -euo pipefail
tag="${1:?usage: smoke-server.sh <image tag>}"
cd "$(dirname "$0")/../.."

compose() { docker compose -f compose.server.yml "$@"; }
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "::group::Logs"
    compose logs --no-color --tail 200 || true
    echo "::endgroup::"
  fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f .env
  exit "$status"
}
trap cleanup EXIT

cp .env.example .env
sed -i "s|^DITTOLY_MASTER_KEY=.*|DITTOLY_MASTER_KEY=$(openssl rand -base64 32)|" .env
printf 'DITTOLY_DOMAIN=localhost\nDITTOLY_VERSION=%s\n' "$tag" >> .env

echo "Starting compose.server.yml with ghcr.io/sudodevstudio/dittoly:$tag"
compose up -d --wait --wait-timeout 240

echo "/ready:"
curl -fsS http://127.0.0.1:8080/ready | tee /dev/stderr | grep -q '"ready":true'
echo

echo "HTTPS through Caddy (its own CA for localhost, hence -k):"
curl -fsSk https://localhost/health
echo

for port in 5432 5433 5672; do
  if timeout 2 bash -c "exec 3<>/dev/tcp/127.0.0.1/$port" 2>/dev/null; then
    echo "::error::port $port is open on the host"; exit 1
  fi
done
echo "PostgreSQL and RabbitMQ: not reachable from the host"

compose exec -T dittoly node dist/src/cli/bootstrap.js admin | grep -q '^token: '
echo "First admin: created"
echo "Smoke test passed for :$tag"
