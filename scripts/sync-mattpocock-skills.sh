#!/usr/bin/env bash
set -euo pipefail

# Sync selected skill buckets from the upstream mattpocock/skills repo into this
# package's ./skills directory.
#
# We only ever touch the buckets listed in BUCKETS below. Anything else under
# ./skills (e.g. buckets you author yourself) is left untouched. Within each
# synced bucket we use `rsync --delete`, so skills removed upstream are also
# removed here — that keeps the mirror faithful.
#
# WARNING: synced buckets are "owned" by upstream. Any local edits to files
# inside engineering/, productivity/, or misc/ will be overwritten on the next
# sync. To customize a skill, copy it into a bucket that isn't synced.
#
# Usage:
#   scripts/sync-mattpocock-skills.sh            # sync from default upstream/ref
#   UPSTREAM_REF=v1.2.3 scripts/sync-mattpocock-skills.sh
#
# Env vars:
#   UPSTREAM_REPO  git URL to clone (default: https://github.com/mattpocock/skills.git)
#   UPSTREAM_REF   branch/tag/commit to sync from (default: main)

UPSTREAM_REPO="${UPSTREAM_REPO:-https://github.com/mattpocock/skills.git}"
UPSTREAM_REF="${UPSTREAM_REF:-main}"
BUCKETS=(engineering productivity misc)

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$REPO_ROOT/skills"

tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

echo "Cloning $UPSTREAM_REPO @ $UPSTREAM_REF ..."
git clone --depth 1 --branch "$UPSTREAM_REF" "$UPSTREAM_REPO" "$tmp/upstream" 2>/dev/null \
  || git clone "$UPSTREAM_REPO" "$tmp/upstream" && git -C "$tmp/upstream" checkout "$UPSTREAM_REF"

src="$tmp/upstream/skills"
if [ ! -d "$src" ]; then
  echo "error: upstream has no skills/ directory" >&2
  exit 1
fi

mkdir -p "$DEST"
for b in "${BUCKETS[@]}"; do
  if [ ! -d "$src/$b" ]; then
    echo "warning: upstream bucket '$b' not found, skipping" >&2
    continue
  fi
  echo "Syncing skills/$b ..."
  rsync -a --delete "$src/$b/" "$DEST/$b/"
done

echo "Done. Synced buckets: ${BUCKETS[*]}"
echo "Upstream commit: $(git -C "$tmp/upstream" rev-parse --short HEAD)"
