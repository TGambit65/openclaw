#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--" ]]; then
  shift
fi

DUR="${1:-2}"
ITER="${2:-1}"

if ! [[ "$DUR" =~ ^[1-9][0-9]*$ ]]; then
  echo "[voice-device-sweep] DUR must be a positive integer" >&2
  exit 1
fi

if ! [[ "$ITER" =~ ^[1-9][0-9]*$ ]]; then
  echo "[voice-device-sweep] ITER must be a positive integer" >&2
  exit 1
fi

mapfile -t DEVICES < <(
  arecord -l 2>/dev/null |
    sed -n 's/^card \([0-9]\+\):.*device \([0-9]\+\):.*/plughw:\1,\2/p' |
    sort -u
)

if [[ ${#DEVICES[@]} -eq 0 ]]; then
  echo "[voice-device-sweep] no capture devices found" >&2
  exit 1
fi

echo "[voice-device-sweep] devices: ${DEVICES[*]}"
for d in "${DEVICES[@]}"; do
  echo "[voice-device-sweep] testing ${d}"
  bash "$(dirname "$0")/test-continuous-voice-loop.sh" "$d" "$DUR" "$ITER"
done

echo "[voice-device-sweep] PASS"
