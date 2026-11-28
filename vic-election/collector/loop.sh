#!/usr/bin/env bash
# Vic election tracker - keep collecting every few minutes for a long stretch inside one workflow run,
# because GitHub's scheduled runs can be delayed for hours on busy nights.
# Usage: loop.sh MINUTES INTERVAL_SECONDS   (MINUTES=0 runs once)
# Created by Josh Avard
set -u
cd "$(dirname "$0")/.."
MINUTES="${1:-0}"; INTERVAL="${2:-180}"
END=$(( $(date +%s) + MINUTES * 60 ))
while :; do
  START=$(date +%s)
  python -m collector.baseline || echo "::warning::Baseline fetch failed; will retry"
  python -m collector.vec --workers 2 || echo "::warning::Scrape failed; keeping last good data"
  python -m collector.analyse || echo "::warning::Analysis failed"
  bash collector/save.sh "Vic election data $(date -u +%Y-%m-%dT%H:%MZ)" || true
  NOW=$(date +%s)
  if [ "$MINUTES" = "0" ] || [ $(( NOW + INTERVAL )) -ge "$END" ]; then break; fi
  WAIT=$(( INTERVAL - (NOW - START) )); [ "$WAIT" -gt 5 ] && sleep "$WAIT"
done
