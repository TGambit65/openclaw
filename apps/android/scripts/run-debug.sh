#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=./android-common.sh
source "$SCRIPT_DIR/android-common.sh"
configure_android_sdk_env "$ANDROID_DIR"

DEVICE_SERIAL="${ANDROID_SERIAL:-}"
DEFAULT_PACKAGE="ai.openclaw.android"
PACKAGE="$DEFAULT_PACKAGE"
ACTIVITY=".MainActivity"
SKIP_INSTALL=0
INSTALL_TASK=":app:installDebug"
INSTALL_TASK_EXPLICIT=0

usage() {
  cat <<'EOF'
Usage:
  ./scripts/run-debug.sh [--serial <adb-serial>] [--package <pkg>] [--activity <activity>] [--task <gradle-task-path>] [--no-install]

Installs the Android debug app and launches the main activity on exactly one connected device.
If multiple devices are attached, pass --serial (or set ANDROID_SERIAL).
Use --no-install for already-installed custom packages, or --task when a custom target should be installed first.
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
    --package)
      require_arg_value "$1" "${2-}" usage
      PACKAGE="$2"
      shift 2
      ;;
    --activity)
      require_arg_value "$1" "${2-}" usage
      ACTIVITY="$2"
      shift 2
      ;;
    --task)
      require_arg_value "$1" "${2-}" usage
      INSTALL_TASK="$2"
      INSTALL_TASK_EXPLICIT=1
      shift 2
      ;;
    --no-install)
      SKIP_INSTALL=1
      shift
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

if [[ "$SKIP_INSTALL" -eq 1 && "$INSTALL_TASK_EXPLICIT" -eq 1 ]]; then
  echo "--task cannot be combined with --no-install." >&2
  usage >&2
  exit 2
fi

if [[ "$SKIP_INSTALL" -eq 0 && "$INSTALL_TASK_EXPLICIT" -eq 0 && "$PACKAGE" != "$DEFAULT_PACKAGE" ]]; then
  echo "Custom package launch requires --no-install or --task <gradle-task-path>." >&2
  usage >&2
  exit 2
fi

require_android_package_name "$PACKAGE"
require_android_activity_name "$ACTIVITY"
require_gradle_install_task_path "$INSTALL_TASK"
ACTIVITY="$(normalize_android_activity_name "$ACTIVITY")"
COMPONENT="${PACKAGE}/${ACTIVITY}"
# `adb shell` joins its remaining argv with spaces and lets the device shell
# parse the result. Preserve valid `$` characters in nested activity names
# instead of letting the remote shell expand them as variables.
ADB_SHELL_COMPONENT="${COMPONENT//\$/\\$}"

if ! command -v adb >/dev/null 2>&1; then
  echo "adb required but missing." >&2
  exit 1
fi

DEVICE_SERIAL="$(resolve_android_serial "$DEVICE_SERIAL")"
export ANDROID_SERIAL="$DEVICE_SERIAL"

if [[ "$SKIP_INSTALL" -eq 0 ]]; then
  "$SCRIPT_DIR/install-debug.sh" --serial "$DEVICE_SERIAL" --task "$INSTALL_TASK"
fi

start_output="$(adb -s "$DEVICE_SERIAL" shell am start -n "$ADB_SHELL_COMPONENT" 2>&1)" || {
  echo "Failed to launch $COMPONENT on device: $DEVICE_SERIAL" >&2
  printf '%s\n' "$start_output" >&2
  exit 1
}

case "$start_output" in
  *"Error type "*|*"Error:"*|*"Exception occurred"*)
    echo "Failed to launch $COMPONENT on device: $DEVICE_SERIAL" >&2
    printf '%s\n' "$start_output" >&2
    exit 1
    ;;
esac

if [[ "$start_output" != *"Starting:"* ]]; then
  echo "Failed to launch $COMPONENT on device: $DEVICE_SERIAL; adb reported success without a launch confirmation." >&2
  if [[ -n "$start_output" ]]; then
    printf '%s\n' "$start_output" >&2
  fi
  exit 1
fi

printf '%s\n' "$start_output"
echo "device_serial=$DEVICE_SERIAL"
echo "component=$COMPONENT"
