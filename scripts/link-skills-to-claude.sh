#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

# Symlinks a curated set of skills into a Claude Code skills directory.
#
# Source of truth is <source>/skills/SUPERSET.txt (one skill path per line,
# relative to <source>/skills). Each listed skill folder is linked as
# <target>/<skill-name> -> <source>/skills/<path>.
#
# Options:
#   --source <dir>   Repo root containing skills/SUPERSET.txt.
#                    Default: the repo this script lives in.
#   --target <dir>   Claude Code skills directory to link into.
#                    Default: $CLAUDE_SKILLS_DIR, else ~/.claude/skills.
#
# Re-running is safe: correct links are left alone, links into THIS source that
# are no longer listed in its SUPERSET.txt are pruned, and real (non-symlink)
# files at a target name are reported and skipped rather than overwritten.
# Multiple sources can safely link into one target; prune only touches links
# that point back into the current source.

SELF_REPO="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$SELF_REPO"
TARGET="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"

while [ $# -gt 0 ]; do
  case "$1" in
    --source) SOURCE="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --source=*) SOURCE="${1#*=}"; shift ;;
    --target=*) TARGET="${1#*=}"; shift ;;
    -h|--help) sed -n '5,18p' "$0"; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; exit 2 ;;
  esac
done

SOURCE="$(cd "$SOURCE" 2>/dev/null && pwd)" || { echo "error: source not found" >&2; exit 1; }
SKILLS_DIR="$SOURCE/skills"
MANIFEST="$SKILLS_DIR/SUPERSET.txt"

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
    cur="$(readlink "$dest")"
    if [ "$cur" = "$src" ]; then
      skipped=$((skipped + 1))
      continue
    fi
    if [ ! -e "$dest" ]; then
      # Dangling link (its target is gone); the slot is dead, claim it.
      ln -sfn "$src" "$dest"
      echo "relinked: $name -> $rel (was broken)"
      linked=$((linked + 1))
      continue
    fi
    # Only update a link that already points into THIS source (a stale path).
    # A live link to a different source is someone else's; never hijack it.
    case "$cur" in
      "$SKILLS_DIR"/*)
        ln -sfn "$src" "$dest"
        echo "relinked: $name -> $rel"
        linked=$((linked + 1))
        ;;
      *)
        echo "warning: $name already links elsewhere ($cur), leaving it" >&2
        skipped=$((skipped + 1))
        ;;
    esac
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

# Prune symlinks in TARGET that point into THIS source's skills dir but are no
# longer listed in its manifest. Links from other sources are left alone.
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
echo "linked/relinked: $linked, already-current: $skipped, pruned: $pruned"
echo "source: $SOURCE"
echo "target: $TARGET"
