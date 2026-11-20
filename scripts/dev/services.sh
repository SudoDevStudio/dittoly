#!/usr/bin/env bash
# Dev/CI helper for the cloud container: start a local Postgres 16 on :5433 and,
# if available, the Docker daemon. Safe to run repeatedly.
set -euo pipefail
PGB=/usr/lib/postgresql/16/bin
DATA=${DITTOLY_PGDATA:-/var/tmp/dittoly-pg}
if ! psql -h 127.0.0.1 -p 5433 -U postgres -tc 'select 1' >/dev/null 2>&1; then
  if [ ! -f "$DATA/PG_VERSION" ]; then
    mkdir -p "$DATA" && chown postgres "$DATA"
    su postgres -c "$PGB/initdb -D $DATA -U postgres --auth=trust" >/dev/null
  fi
  rm -f "$DATA/postmaster.pid"
  su postgres -c "$PGB/pg_ctl -D $DATA -o '-p 5433 -k /tmp' -l $DATA/log -w start" >/dev/null
fi
for db in dittoly dittoly_test; do
  psql -h 127.0.0.1 -p 5433 -U postgres -tc "select 1 from pg_database where datname='$db'" | grep -q 1 \
    || psql -q -h 127.0.0.1 -p 5433 -U postgres -c "create database $db"
done
if command -v dockerd >/dev/null && ! docker info >/dev/null 2>&1; then
  (dockerd >/var/tmp/dockerd.log 2>&1 &)
  for _ in $(seq 1 20); do docker info >/dev/null 2>&1 && break; sleep 0.5; done
fi
# RabbitMQ for the shared-server webhook queue (user dittoly/dittoly on :5672).
# Runs as the image's own user: this container's storage driver breaks the entrypoint's chown.
if docker info >/dev/null 2>&1 && ! docker exec dty-rabbit rabbitmq-diagnostics -q check_port_connectivity >/dev/null 2>&1; then
  docker rm -f dty-rabbit >/dev/null 2>&1 || true
  docker run -d --name dty-rabbit -p 127.0.0.1:5672:5672 --user 100:101 -e HOME=/var/lib/rabbitmq rabbitmq:4.2-alpine >/dev/null
  for _ in $(seq 1 60); do docker exec dty-rabbit rabbitmq-diagnostics -q check_port_connectivity >/dev/null 2>&1 && break; sleep 2; done
  docker exec dty-rabbit sh -c 'rabbitmqctl -q add_user dittoly dittoly && rabbitmqctl -q set_permissions -p / dittoly ".*" ".*" ".*"' >/dev/null
fi
rabbit=$(docker exec dty-rabbit rabbitmq-diagnostics -q check_port_connectivity >/dev/null 2>&1 && echo up || echo unavailable)
echo "postgres: up on 127.0.0.1:5433; docker: $(docker info >/dev/null 2>&1 && echo up || echo unavailable); rabbitmq: $rabbit"
