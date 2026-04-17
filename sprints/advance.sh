#!/usr/bin/env bash
# advance.sh — pop next sprint from queue and launch it via Claude Code
# Called by the Stop hook in .claude/settings.json

QUEUE="$HOME/git/operad/sprints/queue.txt"

# Exit silently if queue is empty or missing
[ -f "$QUEUE" ] || exit 0
[ -s "$QUEUE" ] || exit 0

# Pop first line
PLAN=$(head -1 "$QUEUE")
tail -n +2 "$QUEUE" > "$QUEUE.tmp" && mv "$QUEUE.tmp" "$QUEUE"

PLAN_FILE="$HOME/git/operad/sprints/$PLAN"
[ -f "$PLAN_FILE" ] || { echo "advance.sh: plan file not found: $PLAN_FILE" >&2; exit 1; }

echo "advance.sh: launching sprint $PLAN"
cd "$HOME/git/operad" && claude --print < "$PLAN_FILE"
