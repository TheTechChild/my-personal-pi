#!/usr/bin/env bash
set -euo pipefail

# Set this repo up for Claude Code: link the public skill superset into your
# Claude Code skills directory, plus the private Angel skills if you have them.
#
# Safe to re-run. Non-Angel users simply get the public superset.
#
# Env overrides:
#   CLAUDE_SKILLS_DIR   target dir       (default ~/.claude/skills)
#   ANGEL_SKILLS_DIR    private repo path (default ~/angel-studios/angel-claude-skills)

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LINKER="$REPO/scripts/link-skills-to-claude.sh"
TARGET="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
ANGEL_SKILLS_DIR="${ANGEL_SKILLS_DIR:-$HOME/angel-studios/angel-claude-skills}"

echo "Linking public superset from $REPO ..."
"$LINKER" --source "$REPO" --target "$TARGET"

if [ -f "$ANGEL_SKILLS_DIR/skills/SUPERSET.txt" ]; then
  echo ""
  echo "Found Angel skills at $ANGEL_SKILLS_DIR, linking ..."
  "$LINKER" --source "$ANGEL_SKILLS_DIR" --target "$TARGET"
else
  echo ""
  echo "No Angel skills repo at $ANGEL_SKILLS_DIR (skipping; fine for non-Angel users)."
fi

echo ""
echo "Claude Code skills ready in $TARGET"
