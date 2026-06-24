#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

# Symlinks the curated superset of skills into a Claude Code skills directory.
# Source of truth is skills/SUPERSET.txt (one skill path per line, relative to
# the skills/ dir). Each listed skill folder is linked as
# <target>/<skill-name> -> <repo>/skills/<path>.
#
# Default target is ~/angel-studios/.claude/skills. Override by passing a path
# as the first argument, or via the CLAUDE_SKILLS_DIR env var.
#
# Re-running is safe: correct links are left alone, links into this repo that
# are no longer listed in SUPERSET.txt are pruned, and a real (non-symlink)
# file at a target name is reported and skipped rather than overwritten.

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS_DIR="$REPO/skills"
MANIFEST="$SKILLS_DIR/SUPERSET.txt"
TARGET="${1:-${CLAUDE_SKILLS_DIR:-$HOME/angel-studios/.claude/skills}}"

if [ ! -f "$MANIFEST" ]; then
  echo "error: manifest not found at $MANIFEST" >&2
  exit 1
fi

mkdir -p "$TARGET"

linked=0
skipped=0
pruned=0
declare -a expected_names=()

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|'#'*) continue ;; esac
  rel="${line%/}"
  src="$SKILLS_DIR/$rel"
  name="$(basename "$rel")"
  expected_names+=("$name")
  dest="$TARGET/$name"

  if [ ! -d "$src" ]; then
    echo "warning: source skill not found, skipping: $rel" >&2
    continue
  fi

  if [ -L "$dest" ]; then
    if [ "$(readlink "$dest")" = "$src" ]; then
      skipped=$((skipped + 1))
      continue
    fi
    ln -sfn "$src" "$dest"
    echo "relinked: $name -> $rel"
    linked=$((linked + 1))
    continue
  fi

  if [ -e "$dest" ]; then
    echo "warning: real file/dir exists at $dest, leaving untouched" >&2
    continue
  fi

  ln -s "$src" "$dest"
  echo "linked: $name -> $rel"
  linked=$((linked + 1))
done < "$MANIFEST"

# Prune symlinks in TARGET that point into this repo's skills dir but are no
# longer listed in the manifest.
for entry in "$TARGET"/*; do
  [ -L "$entry" ] || continue
  case "$(readlink "$entry")" in
    "$SKILLS_DIR"/*) ;;
    *) continue ;;
  esac
  name="$(basename "$entry")"
  keep=false
  for n in "${expected_names[@]}"; do
    if [ "$n" = "$name" ]; then keep=true; break; fi
  done
  if [ "$keep" = false ]; then
    rm "$entry"
    echo "pruned stale link: $name"
    pruned=$((pruned + 1))
  fi
done

echo ""
echo "Done. linked/relinked: $linked, already-current: $skipped, pruned: $pruned"
echo "Target: $TARGET"
