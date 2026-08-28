#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--" ]]; then
  shift
fi

CARD_DEVICE="${1:-plughw:1,0}"
DUR="${2:-2}"
ITERATIONS="${3:-2}"

if ! [[ "$DUR" =~ ^[1-9][0-9]*$ ]]; then
  echo "[voice-loop] DUR must be a positive integer" >&2
  exit 1
fi

if ! [[ "$ITERATIONS" =~ ^[0-9]+$ ]] || [[ "$ITERATIONS" -lt 1 ]]; then
  echo "[voice-loop] ITERATIONS must be a positive integer" >&2
  exit 1
fi

echo "[voice-loop] start device=${CARD_DEVICE} dur=${DUR}s iterations=${ITERATIONS}"
for ((i=1; i<=ITERATIONS; i++)); do
  echo "[voice-loop] iteration ${i}/${ITERATIONS}"
  bash "$(dirname "$0")/test-continuous-voice-stack.sh" "$CARD_DEVICE" "$DUR"
done

echo "[voice-loop] PASS"
