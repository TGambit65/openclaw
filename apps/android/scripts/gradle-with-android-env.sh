#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=./android-common.sh
source "$SCRIPT_DIR/android-common.sh"
configure_android_sdk_env "$ANDROID_DIR"

GRADLEW="./gradlew"
if [[ -n "${ANDROID_GRADLEW:-}" ]]; then
  GRADLEW="$(make_path_absolute "$ANDROID_GRADLEW")"
fi

usage() {
  cat <<'EOF'
Usage:
  ./scripts/gradle-with-android-env.sh <gradle-task-or-arg> [...]

Runs Gradle after applying the Android SDK environment discovery used by the
Android helper scripts.
EOF
}

if [[ "${1-}" == "-h" || "${1-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -eq 0 ]]; then
  echo "Missing Gradle task or argument." >&2
  usage >&2
  exit 2
fi

cd "$ANDROID_DIR"
require_android_sdk_env "$ANDROID_DIR"
require_executable_file "Gradle wrapper" "$GRADLEW"
exec "$GRADLEW" "$@"
