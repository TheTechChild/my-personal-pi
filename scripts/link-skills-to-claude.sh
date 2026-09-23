#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

# Symlinks a curated set of skills into a Claude Code skills directory.
#
# Source of truth is <source>/skills/SUPERSET.txt (one skill path per line,
# relative to <source>/skills). Each listed skill folder is linked as
# <target>/<skill-name> -> <source>/skills/<path>, stored as a RELATIVE target so the
# links keep working when the home directory moves or the profile name changes.
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
# that point back into the current source. A link stored as an absolute path from an
# older run still counts as this source's own, and is rewritten to a relative one.

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

SOURCE="$(cd "$SOURCE" 2>/dev/null && pwd -P)" || { echo "error: source not found" >&2; exit 1; }
SKILLS_DIR="$SOURCE/skills"
MANIFEST="$SKILLS_DIR/SUPERSET.txt"

if [ ! -f "$MANIFEST" ]; then
  echo "error: manifest not found at $MANIFEST" >&2
  exit 1
fi

mkdir -p "$TARGET"
TARGET="$(cd "$TARGET" && pwd -P)"

# Absolute path a symlink points at, resolved against the directory holding the link.
resolve_target() {   # $1 = stored target, $2 = directory holding the link
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *)  ( cd "$2" && cd "$(dirname "$1")" 2>/dev/null \
            && printf '%s/%s\n' "$(pwd -P)" "$(basename "$1")" ) || printf '%s\n' "$1" ;;
  esac
}

# $1 expressed relative to directory $2. Both must be absolute.
relative_to() {
  local target="${1%/}" from="${2%/}" up="" rest=""
  while [ -n "$from" ] && [ "$from" != "/" ] && [ "${target#"$from"/}" = "$target" ]; do
    from="$(dirname "$from")"
    up="../$up"
  done
  if [ -z "$from" ] || [ "$from" = "/" ]; then
    rest="${target#/}"          # walked all the way to the root
  else
    rest="${target#"$from"/}"
  fi
  printf '%s%s\n' "$up" "$rest"
}

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
  link_target="$(relative_to "$src" "$TARGET")"

  if [ ! -d "$src" ]; then
    echo "warning: source skill not found, skipping: $rel" >&2
    continue
  fi

  if [ -L "$dest" ]; then
    cur="$(readlink "$dest")"
    if [ "$cur" = "$link_target" ]; then
      skipped=$((skipped + 1))
      continue
    fi
    if [ ! -e "$dest" ]; then
      # Dangling link (its target is gone); the slot is dead, claim it.
      ln -sfn "$link_target" "$dest"
      echo "relinked: $name -> $rel (was broken)"
      linked=$((linked + 1))
      continue
    fi
    # Only update a link that already points into THIS source, whether it was
    # stored absolute or relative. A live link to another source is someone
    # else's; never hijack it.
    case "$(resolve_target "$cur" "$TARGET")" in
      "$SKILLS_DIR"/*)
        ln -sfn "$link_target" "$dest"
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

  ln -s "$link_target" "$dest"
  echo "linked: $name -> $rel"
  linked=$((linked + 1))
done < "$MANIFEST"

# Prune symlinks in TARGET that point into THIS source's skills dir but are no
# longer listed in its manifest. Links from other sources are left alone.
for entry in "$TARGET"/*; do
  [ -L "$entry" ] || continue
  case "$(resolve_target "$(readlink "$entry")" "$TARGET")" in
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
