#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPO_DIR=/workspace/vaporstats
readonly COMPOSE_FILE="$REPO_DIR/compose.yaml"
readonly DATA_DIR="$REPO_DIR/data"
readonly DATABASE_PATH="$DATA_DIR/vaporstats.sqlite"
readonly SNAPSHOT_ROOT="$DATA_DIR/snapshots"
readonly LOCK_FILE=/run/lock/vaporstats-deploy.lock
readonly CONTAINER_NAME=vaporstats
readonly IMAGE_REPOSITORY=vaporstats
readonly ROLLBACK_IMAGE="$IMAGE_REPOSITORY:previous"
readonly HEALTH_TIMEOUT_SECONDS="${DEPLOY_HEALTH_TIMEOUT_SECONDS:-90}"

fail() {
  printf 'deploy: %s\n' "$*" >&2
  exit 1
}

(( EUID == 0 )) || fail 'must run as root'
(( $# == 1 )) || fail 'usage: scripts/deploy.sh <40hex commit>'

requested_input=$1
[[ "$requested_input" =~ ^[0-9a-fA-F]{40}$ ]] || fail 'commit must be exactly 40 hexadecimal characters'
[[ "$HEALTH_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || fail 'DEPLOY_HEALTH_TIMEOUT_SECONDS must be a positive integer'

command -v docker >/dev/null || fail 'docker is required'
command -v git >/dev/null || fail 'git is required'
command -v flock >/dev/null || fail 'flock is required'
[[ -d "$REPO_DIR/.git" ]] || fail "missing git repository: $REPO_DIR"
[[ -f "$COMPOSE_FILE" ]] || fail "missing compose file: $COMPOSE_FILE"

cd "$REPO_DIR"
mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock 9

git fetch --prune origin main
main_tip=$(git rev-parse --verify origin/main^{commit})
requested_commit=$(git rev-parse --verify "$requested_input^{commit}")
git merge-base --is-ancestor "$requested_commit" "$main_tip" || \
  fail "commit $requested_commit is not an ancestor of origin/main"
[[ "$requested_commit" == "$main_tip" ]] || \
  fail "commit $requested_commit is stale; origin/main is $main_tip"

if ! git diff-index --quiet HEAD --; then
  fail "deployment checkout has tracked changes"
fi

previous_image_id=$(docker inspect --format '{{.Image}}' "$CONTAINER_NAME" 2>/dev/null || true)
[[ -n "$previous_image_id" ]] || fail "missing running container: $CONTAINER_NAME"
docker image tag "$previous_image_id" "$ROLLBACK_IMAGE"

git checkout --detach "$requested_commit"
export VAPORSTATS_IMAGE_TAG="$requested_commit"

compose() {
  docker compose -p vaporstats -f "$COMPOSE_FILE" "$@"
}

# Build while the old container still serves traffic.
compose build vaporstats
docker image inspect "$IMAGE_REPOSITORY:$requested_commit" >/dev/null

snapshot_dir=
rollback_required=0
snapshot_ready=0

restore_database() {
  [[ -n "$snapshot_dir" && -d "$snapshot_dir" ]] || return 0
  rm -f "$DATABASE_PATH" "$DATABASE_PATH-wal" "$DATABASE_PATH-shm"
  for name in vaporstats.sqlite vaporstats.sqlite-wal vaporstats.sqlite-shm; do
    [[ -e "$snapshot_dir/$name" ]] || continue
    cp -a "$snapshot_dir/$name" "$DATA_DIR/$name"
  done
}

wait_for_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
  local status
  local expected_image_id
  local running_image_id
  expected_image_id=$(docker image inspect "$IMAGE_REPOSITORY:$VAPORSTATS_IMAGE_TAG" --format '{{.Id}}' 2>/dev/null || true)
  [[ -n "$expected_image_id" ]] || return 1
  while (( SECONDS < deadline )); do
    status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER_NAME" 2>/dev/null || true)
    running_image_id=$(docker inspect --format '{{.Image}}' "$CONTAINER_NAME" 2>/dev/null || true)
    if [[ "$running_image_id" == "$expected_image_id" ]]; then
      case "$status" in
        healthy)
          return 0
          ;;
        unhealthy|exited|dead) return 1 ;;
      esac
    fi
    sleep 2
  done
  return 1
}

rollback() {
  local deployment_status=$?
  trap - EXIT
  if (( rollback_required )); then
    printf 'deploy: restoring previous image and database\n' >&2
    set +e
    compose rm -sf vaporstats
    if (( snapshot_ready )); then
      restore_database
    fi
    export VAPORSTATS_IMAGE_TAG=previous
    compose up -d --no-build vaporstats
    if ! wait_for_healthy; then
      printf 'deploy: rollback container did not become healthy\n' >&2
    fi
  fi
  exit "$deployment_status"
}
trap rollback EXIT

compose stop vaporstats
rollback_required=1
mkdir -p "$SNAPSHOT_ROOT"
snapshot_dir=$(mktemp -d "$SNAPSHOT_ROOT/deploy-$requested_commit.XXXXXX")
for path in "$DATABASE_PATH" "$DATABASE_PATH-wal" "$DATABASE_PATH-shm"; do
  [[ -e "$path" ]] || continue
  cp -a "$path" "$snapshot_dir/$(basename "$path")"
done
snapshot_ready=1

# The migration image must see a coherent pre-migration database.
check_database_integrity() {
  [[ -e "$DATABASE_PATH" ]] || return 0
  compose run --rm --no-deps -T vaporstats bun -e 'const { Database } = require("bun:sqlite"); const db = new Database(process.env.DATABASE_PATH, { readonly: true }); const result = db.query("PRAGMA integrity_check").get(); if (result?.integrity_check !== "ok") { console.error(result); process.exit(1); } db.close();'
}

check_database_integrity
# Migrations are an explicit runtime artifact; generation never runs here.
compose run --rm --no-deps -T vaporstats bun dist/migrate.js
compose up -d --no-build vaporstats
wait_for_healthy || fail 'new container did not become healthy'

rollback_required=0
trap - EXIT
printf 'deploy: %s is healthy\n' "$requested_commit"