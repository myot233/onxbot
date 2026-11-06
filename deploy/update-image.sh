#!/usr/bin/env bash
set -euo pipefail

cd "${ONXBOT_DEPLOY_DIR:-$HOME/services/onxbot}"
exec 9>.ghcr-update.lock
flock -n 9 || exit 0

source_image=ghcr.io/myot233/onxbot:main
local_image=onxbot-local:ghcr-deployed
compose=(docker compose -f compose.yaml -f compose.override.yaml -f deploy/compose.ghcr.yaml)

container=$("${compose[@]}" ps --all --quiet bot)
previous=''
if [[ -n "$container" ]]; then
  previous=$(docker inspect --format '{{.Image}}' "$container")
fi

docker pull "$source_image"
candidate=$(docker image inspect --format '{{.Id}}' "$source_image")
if [[ "$candidate" == "$previous" ]] &&
   [[ "$(docker inspect --format '{{.State.Running}}' "$container")" == true ]]; then
  exit 0
fi
if [[ -f .ghcr-rejected-image ]] && [[ "$(<.ghcr-rejected-image)" == "$candidate" ]]; then
  echo "Skipping previously rejected image $candidate"
  exit 0
fi

wait_for_panel() {
  local status
  if [[ -z "${ONXBOT_PROBE_URL:-}" ]]; then
    return 0
  fi
  for ((attempt = 0; attempt < 15; attempt++)); do
    if status=$(curl --silent --max-time 2 --output /dev/null --write-out '%{http_code}' "$ONXBOT_PROBE_URL") &&
       [[ "$status" == 200 || "$status" == 401 ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

start_bot() {
  "${compose[@]}" up -d --no-deps --no-build --pull never --wait --wait-timeout 30 bot &&
    wait_for_panel
}

docker tag "$candidate" "$local_image"
if ! "${compose[@]}" run --rm --no-deps -T migrate </dev/null; then
  if [[ -n "$previous" ]]; then
    docker tag "$previous" "$local_image"
  fi
  echo 'Migration failed. The running bot was not replaced.' >&2
  exit 1
fi

if ! start_bot; then
  echo 'The new bot did not become ready.' >&2
  printf '%s\n' "$candidate" > .ghcr-rejected-image
  if [[ -n "$previous" && "$previous" != "$candidate" ]]; then
    docker tag "$previous" "$local_image"
    start_bot || echo 'The previous bot image did not become ready.' >&2
  fi
  exit 1
fi
rm -f .ghcr-rejected-image
echo "Updated onxbot to $candidate"
