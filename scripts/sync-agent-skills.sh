#!/usr/bin/env bash
# Sync canonical skill bundles from src/guidelines/skills/ to the agent skill
# dir. Run from the repo root.
#
# Why: src/guidelines/skills/<name>/SKILL.md is the single source of truth (it's
# what `backlog init` ships to user projects). The copy under .codex/skills/
# drifts if hand-edited (it once still referenced a removed CLI command). This
# regenerates it so the two never diverge.
#
# .claude/skills is a symlink to .codex/skills, so Claude and Codex share one
# physical dir — we write it once. Cursor/Gemini have no skill-bundle concept;
# they read AGENTS.md, generated separately by `backlog init`. Nothing to do here.
set -euo pipefail

cd "$(dirname "$0")/.."

SRC="src/guidelines/skills"
DEST=".codex/skills"

[ -d "$SRC" ] || { echo "missing $SRC" >&2; exit 1; }

for skill_dir in "$SRC"/*/; do
	name="$(basename "$skill_dir")"
	[ -f "$skill_dir/SKILL.md" ] || continue
	mkdir -p "$DEST/$name"
	cp "$skill_dir/SKILL.md" "$DEST/$name/SKILL.md"
	echo "synced $name -> $DEST/$name/SKILL.md"
done
