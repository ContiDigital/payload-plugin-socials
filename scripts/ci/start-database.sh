#!/usr/bin/env bash

set -Eeuo pipefail

database="${1:-}"
image="${2:-}"
container="payload-socials-${database}"

if [[ "$database" != "postgres" && "$database" != "mongodb" ]]; then
  echo "database must be postgres or mongodb" >&2
  exit 2
fi
if [[ -z "$image" ]]; then
  echo "database image is required" >&2
  exit 2
fi

pulled=false
for attempt in 1 2 3 4 5; do
  if docker pull "$image"; then
    pulled=true
    break
  fi
  if [[ "$attempt" -lt 5 ]]; then
    delay_seconds=$((attempt * 10))
    echo "::warning::Database image pull failed (attempt ${attempt}/5); retrying in ${delay_seconds}s"
    sleep "$delay_seconds"
  fi
done
if [[ "$pulled" != "true" ]]; then
  echo "::error::Database image pull failed after 5 attempts"
  exit 1
fi

if [[ "$database" == "postgres" ]]; then
  docker run --detach \
    --env POSTGRES_DB=socials_test \
    --env POSTGRES_PASSWORD=postgres \
    --env POSTGRES_USER=postgres \
    --name "$container" \
    --publish 5432:5432 \
    "$image"
else
  docker run --detach \
    --name "$container" \
    --publish 27017:27017 \
    "$image"
fi

for _attempt in {1..30}; do
  if [[ "$database" == "postgres" ]]; then
    if docker exec "$container" pg_isready -U postgres -d socials_test >/dev/null 2>&1; then
      exit 0
    fi
  elif docker exec "$container" mongosh --quiet \
    --eval 'quit(db.adminCommand({ ping: 1 }).ok ? 0 : 1)' >/dev/null 2>&1; then
    exit 0
  fi
  sleep 2
done

docker logs "$container"
echo "::error::${database} did not become ready within 60 seconds"
exit 1
