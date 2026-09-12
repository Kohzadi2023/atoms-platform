#!/bin/sh
set -eu
# Exact three ephemeral services only. Never point this at a cloud Redis root.
redis-cli --cluster create redis-1:6379 redis-2:6379 redis-3:6379 --cluster-replicas 0 --cluster-yes
for attempt in $(seq 1 30); do
  if redis-cli -h redis-1 cluster info | tr -d '\r' | grep -Fx 'cluster_state:ok'; then
    exit 0
  fi
  sleep 1
done
exit 1
