#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--" ]]; then
  shift
fi

CARD_DEVICE="${1:-plughw:1,0}"
DUR="${2:-3}"
OUT="/tmp/openclaw-voice-audio-io-$(date +%s).wav"

if ! [[ "$DUR" =~ ^[1-9][0-9]*$ ]]; then
  echo "[voice-audio-io] DUR must be a positive integer" >&2
  exit 1
fi

if ! command -v arecord >/dev/null 2>&1 || ! command -v aplay >/dev/null 2>&1; then
  echo "[voice-audio-io] arecord/aplay required" >&2
  exit 1
fi

echo "[voice-audio-io] recording ${DUR}s from ${CARD_DEVICE} -> ${OUT}"
timeout "${DUR}" arecord -D "${CARD_DEVICE}" -f S16_LE -r 16000 -c 1 "${OUT}" >/tmp/openclaw-voice-audio-io-record.log 2>&1 || true

if [[ ! -s "${OUT}" ]]; then
  echo "[voice-audio-io] FAIL: no audio captured"
  sed -n '1,40p' /tmp/openclaw-voice-audio-io-record.log || true
  exit 2
fi

echo "[voice-audio-io] captured: $(ls -lh "${OUT}" | awk '{print $5, $9}')"
echo "[voice-audio-io] playback check"
timeout "${DUR}" aplay "${OUT}" >/tmp/openclaw-voice-audio-io-play.log 2>&1 || true
sed -n '1,2p' /tmp/openclaw-voice-audio-io-play.log || true

echo "[voice-audio-io] PASS"
