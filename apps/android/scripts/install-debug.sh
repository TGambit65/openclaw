#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=./android-common.sh
source "$SCRIPT_DIR/android-common.sh"
configure_android_sdk_env "$ANDROID_DIR"

DEVICE_SERIAL="${ANDROID_SERIAL:-}"
GRADLE_TASK=":app:installDebug"
GRADLEW="./gradlew"
if [[ -n "${ANDROID_GRADLEW:-}" ]]; then
  GRADLEW="$(make_path_absolute "$ANDROID_GRADLEW")"
fi

usage() {
  cat <<'EOF'
Usage:
  ./scripts/install-debug.sh [--serial <adb-serial>] [--task <gradle-task-path>]

Installs the Android debug app onto exactly one connected device.
If multiple devices are attached, pass --serial (or set ANDROID_SERIAL).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      break
      ;;
    --serial)
      require_arg_value "$1" "${2-}" usage
      DEVICE_SERIAL="$2"
      shift 2
      ;;
    --task)
      require_arg_value "$1" "${2-}" usage
      GRADLE_TASK="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ $# -gt 0 ]]; then
  echo "Unexpected positional args: $*" >&2
  usage >&2
  exit 2
fi

require_gradle_install_task_path "$GRADLE_TASK"

if ! command -v adb >/dev/null 2>&1; then
  echo "adb required but missing." >&2
  exit 1
fi

DEVICE_SERIAL="$(resolve_android_serial "$DEVICE_SERIAL")"
export ANDROID_SERIAL="$DEVICE_SERIAL"

cd "$ANDROID_DIR"
require_android_sdk_env "$ANDROID_DIR"
require_executable_file "Gradle wrapper" "$GRADLEW"
if ! ANDROID_SERIAL="$DEVICE_SERIAL" "$GRADLEW" "$GRADLE_TASK" -Pandroid.injected.device.serial="$DEVICE_SERIAL" --console=plain; then
  echo "Gradle install failed for device: $DEVICE_SERIAL" >&2
  exit 1
fi

echo "device_serial=$DEVICE_SERIAL"
echo "gradle_task=$GRADLE_TASK"
