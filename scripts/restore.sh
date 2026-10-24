#!/usr/bin/env bash
# Restores a brr-chat server from a snapshot (ADR 0023). Run on the Docker host, as a user
# that can run docker. Runbook: docs/DEPLOY.md, "Restore".
#
#   scripts/restore.sh <container>                      # newest snapshot in its /backups
#   scripts/restore.sh <container> brr-chat-<stamp>.db  # a named snapshot in its /backups
#   scripts/restore.sh <container> ./file.db            # a snapshot file on this host
#   scripts/restore.sh <container> ./archive.tar.gz     # a Coolify storage-backup archive
#
# <container> is the brr service's container (`docker ps`; in Coolify, brr-<uuid>). The
# work is done by `brr-chat restore` inside a one-off container of the same image, on the
# same volumes: it refuses a file that is not a whole brr-chat database, moves the live DB
# and its WAL to /data/before-restore-<time>/, and raises the id counters so devices never
# see a seq or media id reused (apps/server/src/restore.ts). The snapshot travels over
# stdin, so no host directory has to be readable by the container's user.
set -euo pipefail

CONTAINER=${1:?usage: restore.sh <container> [snapshot name | .db file | .tar.gz archive]}
SOURCE=${2:-}
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

docker inspect "$CONTAINER" >/dev/null 2>&1 || { echo "no such container: $CONTAINER" >&2; exit 1; }
# The image the container runs, by id: the restore logic matches the binary that will open it.
IMAGE=$(docker inspect -f '{{.Image}}' "$CONTAINER")

# Stage the chosen snapshot as $STAGE/restore.db.
if [ -z "$SOURCE" ] || [[ "$SOURCE" == brr-chat-*.db && ! -e "$SOURCE" ]]; then
  docker cp "$CONTAINER:/backups" "$STAGE/" >/dev/null
  if [ -z "$SOURCE" ]; then
    SOURCE=$(find "$STAGE/backups" -name 'brr-chat-*.db' -printf '%f\n' | sort | tail -1)
    [ -n "$SOURCE" ] || { echo "no snapshots in $CONTAINER:/backups" >&2; exit 1; }
  fi
  [ -f "$STAGE/backups/$SOURCE" ] || { echo "no $SOURCE in $CONTAINER:/backups" >&2; exit 1; }
  mv "$STAGE/backups/$SOURCE" "$STAGE/restore.db"
elif [[ "$SOURCE" == *.tar.gz || "$SOURCE" == *.tgz ]]; then
  mkdir "$STAGE/archive"
  tar -xzf "$SOURCE" -C "$STAGE/archive"
  newest=$(find "$STAGE/archive" -name 'brr-chat-*.db' -printf '%f\t%p\n' | sort | tail -1 | cut -f2)
  [ -n "$newest" ] || { echo "no brr-chat-*.db inside $SOURCE" >&2; exit 1; }
  echo "archive: using $(basename "$newest")"
  cp "$newest" "$STAGE/restore.db"
else
  [ -f "$SOURCE" ] || { echo "no such file: $SOURCE" >&2; exit 1; }
  cp "$SOURCE" "$STAGE/restore.db"
fi

echo "stopping $CONTAINER"
# Whatever happens next, the server comes back: an error or Ctrl-C while stopping or
# restoring still leaves it running, on the old file if the snapshot was refused.
trap 'docker start "$CONTAINER" >/dev/null; echo "started $CONTAINER"; rm -rf "$STAGE"' EXIT
# -t 30 matches the compose stop_grace_period, so the server drains before it is killed.
docker stop -t 30 "$CONTAINER" >/dev/null
docker run --rm -i --network none --read-only --user 65532:65532 \
  --volumes-from "$CONTAINER" "$IMAGE" restore - <"$STAGE/restore.db"
echo "restored from $SOURCE; watch: docker logs -f $CONTAINER"
