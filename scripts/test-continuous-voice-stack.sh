#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--" ]]; then
  shift
fi

CARD_DEVICE="${1:-plughw:1,0}"
DUR="${2:-3}"

if ! [[ "$DUR" =~ ^[1-9][0-9]*$ ]]; then
  echo "[voice-stack] DUR must be a positive integer" >&2
  exit 1
fi

echo "[voice-stack] starting local continuous voice stack checks"

echo "[voice-stack] step 1/2: config + closed-loop tests"
bash "$(dirname "$0")/test-continuous-voice-local.sh"

echo "[voice-stack] step 2/2: live audio capture + playback"
bash "$(dirname "$0")/test-continuous-voice-audio-io.sh" "$CARD_DEVICE" "$DUR"

echo "[voice-stack] PASS"
