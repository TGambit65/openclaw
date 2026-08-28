#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ORIGINAL_ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-}"
ORIGINAL_ANDROID_HOME="${ANDROID_HOME:-}"
# shellcheck source=./android-common.sh
source "$SCRIPT_DIR/android-common.sh"
configure_android_sdk_env "$ANDROID_DIR"

DEFAULT_PACKAGE="ai.openclaw.android"
PACKAGE="$DEFAULT_PACKAGE"
ACTIVITY=".MainActivity"
DURATION_SECONDS="10"
OUTPUT_PERF_DATA=""
OUTPUT_PERF_DATA_PERMISSIONS=""
OUTPUT_PERF_DATA_PREEXISTED=0
OUTPUT_PERF_DATA_STATE=""
DEFAULT_OUTPUT_RESERVATION=""
DEVICE_SERIAL="${ANDROID_SERIAL:-}"
PROFILE_ARCH=""
PROFILE_ARCH_EXPLICIT=0
INSTALL_BEFORE_CAPTURE=1
INSTALL_TASK=":app:installDebug"
INSTALL_TASK_EXPLICIT=0
GRADLEW="./gradlew"
if [[ -n "${ANDROID_GRADLEW:-}" ]]; then
  GRADLEW="$(make_path_absolute "$ANDROID_GRADLEW")"
fi
# Simpleperf only wraps fields containing the configured separator in quotes;
# the lightweight awk parser below intentionally doesn't implement CSV quoting.
# Use an ASCII unit separator so demangled C++ symbols (for example operator|)
# can't be mistaken for column boundaries.
CSV_SEPARATOR=$'\x1f'
REPORTER_SUPPORTS_CSV=0
REPORTER_SUPPORTS_CSV_SEPARATOR=0
REPORTER_SUPPORTS_PERCENT_LIMIT=0
ADB_DAEMON_USER=""
LEGACY_PERF_HARDEN_ORIGINAL=""
LEGACY_PERF_HARDEN_RESTORE_PENDING=0

cleanup_default_output_reservation() {
  local exit_status=$?
  if [[ -n "$DEFAULT_OUTPUT_RESERVATION" && ( -f "$DEFAULT_OUTPUT_RESERVATION" || -L "$DEFAULT_OUTPUT_RESERVATION" ) ]]; then
    rm -f -- "$DEFAULT_OUTPUT_RESERVATION"
  fi
  return "$exit_status"
}

usage() {
  cat <<'EOF'
Usage:
  ./scripts/perf-startup-hotspots.sh [--package <pkg>] [--activity <activity>] [--arch <arm|arm64|x86|x86_64>] [--duration <sec>] [--serial <adb-serial>] [--out <perf.data>] [--install-task <gradle-task-path>] [--no-install]

Captures startup CPU profile via simpleperf (app_profiler.py), then prints concise hotspot summaries.
Default package/activity target OpenClaw Android startup.
By default, installs the OpenClaw debug app first. Use --no-install for an already-installed target,
or pass --install-task when profiling a custom package that should be installed first.
Current app_profiler.py releases select the device architecture automatically.
Legacy releases use the installed package/device ABI, or an explicit --arch override.
Legacy releases' security.perf_harden change is restored and verified after capture.
Refuses to run when the selected adb daemon is already root because upstream
--disable_adb_root would otherwise call adb unroot and change daemon privilege.
EOF
}

simpleperf_arch_from_android_abi() {
  local abi="${1%%,*}"
  abi="${abi//$'\r'/}"
  abi="${abi//[[:space:]]/}"
  case "$abi" in
    arm64|arm64-v8a)
      printf 'arm64\n'
      ;;
    arm|armeabi|armeabi-v7a)
      printf 'arm\n'
      ;;
    x86_64)
      printf 'x86_64\n'
      ;;
    x86)
      printf 'x86\n'
      ;;
    *)
      return 1
      ;;
  esac
}

require_simpleperf_arch() {
  local value="$1"
  case "$value" in
    arm|arm64|x86|x86_64)
      ;;
    *)
      echo "--arch must be one of arm, arm64, x86, or x86_64; got: $value" >&2
      usage >&2
      exit 2
      ;;
  esac
}

require_non_root_adb_daemon() {
  local identity_output=""
  local identity=""

  if ! identity_output="$(adb -s "$DEVICE_SERIAL" shell whoami 2>&1)"; then
    echo "Failed to inspect adb daemon user on device: $DEVICE_SERIAL" >&2
    printf '%s\n' "$identity_output" >&2
    exit 1
  fi

  identity="${identity_output//$'\r'/}"
  if [[ "$identity" == *"root"* ]]; then
    echo "Refusing to invoke Simpleperf because upstream --disable_adb_root would run 'adb unroot' and change daemon privilege on device: $DEVICE_SERIAL" >&2
    echo "Run adb unroot explicitly for the selected serial, then retry." >&2
    exit 1
  fi
  if [[ "$identity" != "shell" ]]; then
    echo "Unexpected adb daemon user on device $DEVICE_SERIAL; expected shell, got: $identity" >&2
    exit 1
  fi

  ADB_DAEMON_USER="$identity"
}

android_property_value_or_die() {
  local property="$1"
  local output=""

  if ! output="$(adb -s "$DEVICE_SERIAL" shell getprop "$property" 2>&1)"; then
    echo "Failed to inspect Android property $property on device: $DEVICE_SERIAL" >&2
    printf '%s\n' "$output" >&2
    return 1
  fi
  output="${output//$'\r'/}"
  if [[ "$output" == *$'\n'* ]]; then
    echo "Unexpected multi-line Android property $property on device $DEVICE_SERIAL: $output" >&2
    return 1
  fi
  printf '%s\n' "$output"
}

prepare_legacy_perf_harden_restore() {
  local safe_value_pattern='^[A-Za-z0-9._-]*$'

  if ! LEGACY_PERF_HARDEN_ORIGINAL="$(android_property_value_or_die security.perf_harden)"; then
    return 1
  fi
  if [[ ! "$LEGACY_PERF_HARDEN_ORIGINAL" =~ $safe_value_pattern ]]; then
    echo "Refusing legacy Simpleperf capture because security.perf_harden has an unsupported value on device $DEVICE_SERIAL: $LEGACY_PERF_HARDEN_ORIGINAL" >&2
    return 1
  fi
  LEGACY_PERF_HARDEN_RESTORE_PENDING=1
}

restore_legacy_perf_harden() {
  local current_value=""
  local restore_output=""
  local restore_value="$LEGACY_PERF_HARDEN_ORIGINAL"
  local verified_value=""

  if [[ "$LEGACY_PERF_HARDEN_RESTORE_PENDING" -eq 0 ]]; then
    return 0
  fi

  if ! current_value="$(android_property_value_or_die security.perf_harden)"; then
    return 1
  fi
  if [[ "$current_value" != "$LEGACY_PERF_HARDEN_ORIGINAL" ]]; then
    # Legacy app_profiler.py is expected to change this property to exactly 0.
    # If another value appears, another actor changed device state during the
    # capture. Do not overwrite that concurrent change with our snapshot.
    if [[ "$current_value" != "0" ]]; then
      echo "security.perf_harden changed unexpectedly during legacy Simpleperf capture on device $DEVICE_SERIAL; expected wrapper-managed value '0' or original '$LEGACY_PERF_HARDEN_ORIGINAL', got '$current_value'. Refusing to overwrite concurrent device state." >&2
      LEGACY_PERF_HARDEN_RESTORE_PENDING=0
      return 1
    fi
    # adb shell joins its remaining argv before the device shell parses them.
    # Preserve an originally unset/empty property by passing a quoted empty
    # string through that remote-shell boundary.
    if [[ -z "$restore_value" ]]; then
      restore_value="''"
    fi
    if ! restore_output="$(adb -s "$DEVICE_SERIAL" shell setprop security.perf_harden "$restore_value" 2>&1)"; then
      echo "Failed to restore security.perf_harden after legacy Simpleperf capture on device: $DEVICE_SERIAL" >&2
      printf '%s\n' "$restore_output" >&2
      return 1
    fi
    if ! verified_value="$(android_property_value_or_die security.perf_harden)"; then
      return 1
    fi
    if [[ "$verified_value" != "$LEGACY_PERF_HARDEN_ORIGINAL" ]]; then
      echo "security.perf_harden was not restored after legacy Simpleperf capture on device $DEVICE_SERIAL; expected '$LEGACY_PERF_HARDEN_ORIGINAL', got '$verified_value'" >&2
      return 1
    fi
  fi

  LEGACY_PERF_HARDEN_RESTORE_PENDING=0
}

detect_app_profiler_interface() {
  local help_output=""
  if ! help_output="$(ANDROID_SERIAL="$DEVICE_SERIAL" uv run --no-project python3 "$app_profiler" --help 2>&1)"; then
    echo "Unable to inspect the Simpleperf app_profiler.py interface. Output:" >&2
    printf '%s\n' "$help_output" >&2
    return 1
  fi

  if [[ "$help_output" != *"--disable_adb_root"* ]]; then
    echo "Unsupported Simpleperf app_profiler.py interface: non-root profiling is unavailable because --disable_adb_root is missing." >&2
    return 1
  fi

  if [[ "$help_output" == *"--profile_from_launch"* && "$help_output" == *"--arch"* ]]; then
    printf 'legacy\n'
    return 0
  fi
  if [[ "$help_output" == *"--compile_java_code"* && "$help_output" == *"--activity"* ]]; then
    printf 'current\n'
    return 0
  fi

  echo "Unsupported Simpleperf app_profiler.py interface: expected the current activity-launch interface or the legacy --profile_from_launch interface." >&2
  return 1
}

resolve_simpleperf_arch() {
  local requested="$1"
  local package_dump=""
  local package_abi=""
  local device_abi=""
  local resolved=""

  if [[ -n "$requested" ]]; then
    require_simpleperf_arch "$requested"
    printf '%s\n' "$requested"
    return 0
  fi

  if ! package_dump="$(adb -s "$DEVICE_SERIAL" shell dumpsys package "$PACKAGE" 2>&1)"; then
    echo "Failed to inspect installed package ABI for $PACKAGE on device: $DEVICE_SERIAL" >&2
    printf '%s\n' "$package_dump" >&2
    return 1
  fi
  package_abi="$(
    printf '%s\n' "$package_dump" | awk -F= '
      /^[[:space:]]*primaryCpuAbi=/ {
        value = $2
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
        if (value != "" && value != "null") {
          print value
          exit
        }
      }
    '
  )"
  if [[ -n "$package_abi" ]]; then
    if resolved="$(simpleperf_arch_from_android_abi "$package_abi")"; then
      printf '%s\n' "$resolved"
      return 0
    fi
    echo "Unsupported installed package ABI for Simpleperf: $package_abi" >&2
    return 1
  fi

  if ! device_abi="$(adb -s "$DEVICE_SERIAL" shell getprop ro.product.cpu.abilist 2>&1)"; then
    echo "Failed to inspect device ABI on: $DEVICE_SERIAL" >&2
    printf '%s\n' "$device_abi" >&2
    return 1
  fi
  if resolved="$(simpleperf_arch_from_android_abi "$device_abi")"; then
    printf '%s\n' "$resolved"
    return 0
  fi
  echo "Unable to map device ABI to a Simpleperf architecture: $device_abi" >&2
  echo "Re-run with --arch <arm|arm64|x86|x86_64>." >&2
  return 1
}

run_report_or_die() {
  local mode="$1"
  local output_path="$2"
  local error_path="$3"
  shift 3

  # Older NDK report.py releases import Tk even for CLI-only reports, which
  # breaks on headless hosts without python3-tk. The bundled host binary is the
  # actual reporter used by report.py, so invoke it directly.
  if ! "$host_simpleperf" report "$@" >"$output_path" 2>"$error_path"; then
    echo "simpleperf report failed for $mode. tail(stderr):" >&2
    tail -n 120 "$error_path" >&2 || true
    exit 1
  fi
}

normalize_legacy_csv_report_or_die() {
  local mode="$1"
  local path="$2"
  local error_path="$3"
  local normalized_path="$path.normalized"

  # Some reporters predate --csv-separator. Normalize their quoted,
  # comma-delimited output before the shared validation and summary paths run.
  if ! uv run --no-project python3 -c '
import csv
import sys

source_path, destination_path = sys.argv[1:]
with open(source_path, "r", encoding="utf-8", errors="surrogateescape", newline="") as source:
    with open(destination_path, "w", encoding="utf-8", errors="surrogateescape", newline="") as destination:
        writer = csv.writer(destination, delimiter="\x1f", lineterminator="\n")
        writer.writerows(csv.reader(source, strict=True))
' "$path" "$normalized_path" 2>>"$error_path"; then
    echo "Failed to normalize legacy simpleperf CSV output for $mode. tail(stderr):" >&2
    tail -n 120 "$error_path" >&2 || true
    exit 1
  fi
  mv -f -- "$normalized_path" "$path"
}

normalize_text_report_to_csv_or_die() {
  local mode="$1"
  local path="$2"
  local error_path="$3"
  local normalized_path="$path.normalized"

  # Older Simpleperf reporter binaries don't support --csv at all. Their text
  # columns are padded to the header widths, so use the header offsets instead
  # of splitting on whitespace (DSO paths and demangled symbols can contain
  # spaces).
  if ! awk -v mode="$mode" -v separator="$CSV_SEPARATOR" '
    function trim(value) {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      return value
    }

    {
      line = $0
      next_dso = index(line, "Shared Object")
      next_symbol = index(line, "Symbol")
      if (index(line, "Overhead") && next_dso) {
        if (mode == "dso,symbol" && !next_symbol) {
          seen_header = 0
          next
        }
        dso_start = next_dso
        symbol_start = next_symbol
        seen_header = 1
        if (!emitted_header) {
          if (mode == "dso,symbol") {
            print "Overhead" separator "Shared Object" separator "Symbol"
          } else {
            print "Overhead" separator "Shared Object"
          }
          emitted_header = 1
        }
        next
      }

      if (!seen_header) {
        next
      }

      overhead = trim(substr(line, 1, dso_start - 1))
      if (overhead !~ /^[0-9]+([.][0-9]+)?%$/) {
        next
      }

      if (mode == "dso,symbol") {
        dso = trim(substr(line, dso_start, symbol_start - dso_start))
        symbol = trim(substr(line, symbol_start))
        if (dso != "" && symbol != "") {
          print overhead separator dso separator symbol
        }
      } else {
        dso = trim(substr(line, dso_start))
        if (dso != "") {
          print overhead separator dso
        }
      }
    }
  ' "$path" >"$normalized_path" 2>>"$error_path"; then
    echo "Failed to normalize text simpleperf output for $mode. tail(stderr):" >&2
    tail -n 120 "$error_path" >&2 || true
    exit 1
  fi
  mv -f -- "$normalized_path" "$path"
}

csv_report_has_usable_rows() {
  local mode="$1"
  local path="$2"
  awk -F "$CSV_SEPARATOR" -v mode="$mode" '
    BEGIN { seen_header = 0; found_row = 0 }
    $1 == "Overhead" {
      seen_header = 1
      for (name in col) {
        delete col[name]
      }
      for (i = 1; i <= NF; i++) {
        col[$i] = i
      }
      next
    }
    seen_header && NF > 0 {
      overhead = col["Overhead"]
      dso = col["Shared Object"]
      symbol = col["Symbol"]
      if (!overhead || !dso) {
        next
      }
      if (mode == "dso,symbol" && !symbol) {
        next
      }
      if ($overhead == "" || $overhead !~ /^[[:space:]]*[0-9]+([.][0-9]+)?%[[:space:]]*$/ || $dso == "") {
        next
      }
      overhead_value = $overhead
      gsub(/[[:space:]%]/, "", overhead_value)
      if ((overhead_value + 0) <= 0 || (overhead_value + 0) > 100) {
        next
      }
      if (mode == "dso,symbol" && $symbol == "") {
        next
      }
      found_row = 1
      exit 0
    }
    END { exit found_row ? 0 : 1 }
  ' "$path"
}

csv_report_or_die() {
  local mode="$1"
  local output_path="$2"
  local error_path="$3"
  shift 3

  if [[ "$REPORTER_SUPPORTS_CSV" -eq 0 ]]; then
    run_report_or_die "$mode" "$output_path" "$error_path" "$@"
    normalize_text_report_to_csv_or_die "$mode" "$output_path" "$error_path"
  elif [[ "$REPORTER_SUPPORTS_CSV_SEPARATOR" -eq 1 ]]; then
    run_report_or_die "$mode" "$output_path" "$error_path" "$@" \
      --csv \
      --csv-separator "$CSV_SEPARATOR"
  else
    run_report_or_die "$mode" "$output_path" "$error_path" "$@" --csv
    normalize_legacy_csv_report_or_die "$mode" "$output_path" "$error_path"
  fi

  if ! grep -q "^Overhead${CSV_SEPARATOR}" "$output_path"; then
    echo "simpleperf report for $mode did not emit the expected CSV header." >&2
    echo "tail(stderr):" >&2
    tail -n 120 "$error_path" >&2 || true
    echo "tail(output):" >&2
    tail -n 40 "$output_path" >&2 || true
    exit 1
  fi

  if ! csv_report_has_usable_rows "$mode" "$output_path"; then
    echo "simpleperf report for $mode emitted no usable sample rows for package: $PACKAGE" >&2
    echo "tail(stderr):" >&2
    tail -n 120 "$error_path" >&2 || true
    echo "tail(output):" >&2
    tail -n 40 "$output_path" >&2 || true
    exit 1
  fi
}

text_report_has_percent_rows() {
  local path="$1"
  awk '
    /Children/ && /Self/ && /Shared Object/ && /Symbol/ {
      seen_header = 1
      next
    }
    seen_header && /^[[:space:]]*[0-9]+([.][0-9]+)?%[[:space:]]+[0-9]+([.][0-9]+)?%[[:space:]]+[^[:space:]]+[[:space:]]+.+/ {
      children = $1
      self = $2
      sub(/%$/, "", children)
      sub(/%$/, "", self)
      if ((children + 0) > 100 || (self + 0) > 100 || ((children + 0) <= 0 && (self + 0) <= 0)) {
        next
      }
      found_row = 1
      exit 0
    }
    END { exit found_row ? 0 : 1 }
  ' "$path"
}

percent_report_or_die() {
  local mode="$1"
  local output_path="$2"
  local error_path="$3"
  shift 3

  run_report_or_die "$mode" "$output_path" "$error_path" "$@"

  if ! text_report_has_percent_rows "$output_path"; then
    echo "simpleperf report for $mode emitted no usable sample rows." >&2
    echo "tail(stderr):" >&2
    tail -n 120 "$error_path" >&2 || true
    echo "tail(output):" >&2
    tail -n 40 "$output_path" >&2 || true
    exit 1
  fi
}

file_permissions_or_die() {
  local path="$1"
  local permissions=""

  if permissions="$(stat -c '%a' "$path" 2>/dev/null)"; then
    :
  elif permissions="$(stat -f '%Lp' "$path")"; then
    :
  else
    echo "Failed to inspect output file permissions: $path" >&2
    exit 1
  fi
  local permissions_pattern='^[0-7]{3,4}$'
  if [[ ! "$permissions" =~ $permissions_pattern ]]; then
    echo "Unexpected output file permissions for $path: $permissions" >&2
    exit 1
  fi
  printf '%s\n' "$permissions"
}

file_metadata_or_die() {
  local path="$1"
  local metadata=""

  if metadata="$(stat -c '%d:%i:%s:%y:%z' "$path" 2>/dev/null)"; then
    :
  elif metadata="$(stat -f '%d:%i:%z:%.9Fm:%.9Fc' "$path" 2>/dev/null)"; then
    :
  else
    echo "Failed to inspect output file state: $path" >&2
    return 1
  fi
  if [[ -z "$metadata" ]]; then
    echo "Output file state was empty: $path" >&2
    return 1
  fi
  printf '%s\n' "$metadata"
}

file_state_or_die() {
  local path="$1"
  local checksum=""
  local metadata_before=""
  local metadata_after=""

  if ! metadata_before="$(file_metadata_or_die "$path")"; then
    exit 1
  fi
  if ! checksum="$(cksum <"$path" | awk '{printf "%s:%s", $1, $2}')"; then
    echo "Failed to checksum output file: $path" >&2
    exit 1
  fi
  # Re-read metadata after the checksum so a file changing during inspection
  # never produces a state token that can later be mistaken for stable.
  if ! metadata_after="$(file_metadata_or_die "$path")"; then
    exit 1
  fi
  if [[ -z "$checksum" || "$metadata_before" != "$metadata_after" ]]; then
    echo "Output file changed while its state was being inspected: $path" >&2
    exit 1
  fi
  printf '%s:%s\n' "$metadata_after" "$checksum"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      break
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
    --arch)
      require_arg_value "$1" "${2-}" usage
      PROFILE_ARCH="$2"
      PROFILE_ARCH_EXPLICIT=1
      shift 2
      ;;
    --duration)
      require_arg_value "$1" "${2-}" usage
      DURATION_SECONDS="$2"
      shift 2
      ;;
    --serial)
      require_arg_value "$1" "${2-}" usage
      DEVICE_SERIAL="$2"
      shift 2
      ;;
    --out)
      require_arg_value "$1" "${2-}" usage
      OUTPUT_PERF_DATA="$(make_path_absolute "$2")"
      shift 2
      ;;
    --install-task)
      require_arg_value "$1" "${2-}" usage
      INSTALL_TASK="$2"
      INSTALL_TASK_EXPLICIT=1
      shift 2
      ;;
    --no-install)
      INSTALL_BEFORE_CAPTURE=0
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

require_positive_integer "--duration" "$DURATION_SECONDS" usage

if [[ "$INSTALL_BEFORE_CAPTURE" -eq 0 && "$INSTALL_TASK_EXPLICIT" -eq 1 ]]; then
  echo "--install-task cannot be combined with --no-install." >&2
  usage >&2
  exit 2
fi

if [[ "$INSTALL_BEFORE_CAPTURE" -eq 1 && "$INSTALL_TASK_EXPLICIT" -eq 0 && "$PACKAGE" != "$DEFAULT_PACKAGE" ]]; then
  echo "Custom package profiling requires --no-install or --install-task <gradle-task-path>." >&2
  usage >&2
  exit 2
fi

require_android_package_name "$PACKAGE"
require_android_activity_name "$ACTIVITY"
require_gradle_install_task_path "$INSTALL_TASK"
if [[ -n "$PROFILE_ARCH" ]]; then
  require_simpleperf_arch "$PROFILE_ARCH"
fi
ACTIVITY="$(normalize_android_activity_name "$ACTIVITY")"
# app_profiler.py forwards the component through `adb shell am start -n`.
# Preserve `$` in nested activity class names instead of letting the device
# shell expand the suffix as a variable.
APP_PROFILER_ACTIVITY="${ACTIVITY//\$/\\$}"

if [[ -z "$OUTPUT_PERF_DATA" ]]; then
  DEFAULT_OUTPUT_RESERVATION="$(make_temp_file_with_suffix "openclaw-startup-$(date +%Y%m%d-%H%M%S)" .perf.data)"
  OUTPUT_PERF_DATA="$DEFAULT_OUTPUT_RESERVATION"
  trap cleanup_default_output_reservation EXIT
fi

if [[ -d "$OUTPUT_PERF_DATA" ]]; then
  echo "--out must be a file path, got directory: $OUTPUT_PERF_DATA" >&2
  exit 2
fi
if [[ -L "$OUTPUT_PERF_DATA" ]]; then
  echo "--out must be a regular file path; symlinks are rejected: $OUTPUT_PERF_DATA" >&2
  exit 2
fi
if [[ -e "$OUTPUT_PERF_DATA" && ! -f "$OUTPUT_PERF_DATA" ]]; then
  echo "--out must be a regular file path; special files are rejected: $OUTPUT_PERF_DATA" >&2
  exit 2
fi
if [[ -f "$OUTPUT_PERF_DATA" ]]; then
  OUTPUT_PERF_DATA_PERMISSIONS="$(file_permissions_or_die "$OUTPUT_PERF_DATA")"
  OUTPUT_PERF_DATA_STATE="$(file_state_or_die "$OUTPUT_PERF_DATA")"
  if [[ -z "$DEFAULT_OUTPUT_RESERVATION" ]]; then
    OUTPUT_PERF_DATA_PREEXISTED=1
  fi
fi

output_parent="$(dirname -- "$OUTPUT_PERF_DATA")"
if [[ -e "$output_parent" && ! -d "$output_parent" ]]; then
  echo "--out parent path is not a directory: $output_parent" >&2
  exit 2
fi
mkdir -p "$output_parent"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv required but missing." >&2
  exit 1
fi

if ! command -v adb >/dev/null 2>&1; then
  echo "adb required but missing." >&2
  exit 1
fi

DEVICE_SERIAL="$(resolve_android_serial "$DEVICE_SERIAL")"
export ANDROID_SERIAL="$DEVICE_SERIAL"

simpleperf_dir=""
host_simpleperf=""
declare -a candidate_simpleperf_dirs=()

add_simpleperf_candidate() {
  local candidate="${1:-}"
  local existing=""
  if [[ -n "$candidate" ]]; then
    for existing in "${candidate_simpleperf_dirs[@]:-}"; do
      if [[ "$existing" == "$candidate" ]]; then
        return
      fi
    done
    candidate_simpleperf_dirs+=("$candidate")
  fi
}

add_ndk_simpleperf_candidate() {
  local ndk_path="${1:-}"
  ndk_path="${ndk_path%/}"
  if [[ -z "$ndk_path" ]]; then
    return
  fi

  add_simpleperf_candidate "$ndk_path"
  add_simpleperf_candidate "$ndk_path/simpleperf"
}

simpleperf_version_key() {
  local version="${1:-}"
  awk -F. '{for (i = 1; i <= NF; i++) printf "%08d", ($i + 0); printf "\n"}' <<<"$version"
}

simpleperf_host_binary_or_empty() {
  local simpleperf_root="$1"
  local host_dir=""
  local binary_name="simpleperf"

  case "$(uname -s)" in
    Darwin)
      host_dir="darwin"
      ;;
    Linux)
      host_dir="linux"
      ;;
    CYGWIN*|MINGW*|MSYS*)
      host_dir="windows"
      binary_name="simpleperf.exe"
      ;;
    *)
      return 0
      ;;
  esac

  local candidate="$simpleperf_root/bin/$host_dir/x86_64/$binary_name"
  if [[ -f "$candidate" && -x "$candidate" ]]; then
    printf '%s\n' "$candidate"
  fi
}

add_simpleperf_from_sdk_root() {
  local sdk_root="${1:-}"
  local candidate=""
  local version=""
  local version_key=""
  if [[ -z "$sdk_root" || ! -d "$sdk_root" ]]; then
    return
  fi
  if [[ -d "$sdk_root/ndk" ]]; then
    while IFS=$'\t' read -r _ candidate; do
      add_simpleperf_candidate "$candidate"
    done < <(
      for candidate in "$sdk_root"/ndk/*/simpleperf; do
        if [[ ! -d "$candidate" ]]; then
          continue
        fi
        version="${candidate%/simpleperf}"
        version="${version##*/}"
        version_key="$(simpleperf_version_key "$version")"
        printf '%s\t%s\n' "$version_key" "$candidate"
      done | sort -r
    )
  fi
  add_simpleperf_candidate "$sdk_root/ndk-bundle/simpleperf"
}

add_simpleperf_from_existing_sdk_root() {
  local sdk_root="${1:-}"
  if [[ -z "$sdk_root" || ! -d "$sdk_root" ]]; then
    return
  fi
  add_simpleperf_from_sdk_root "$(existing_dir_absolute "$sdk_root")"
}

if [[ -n "${ANDROID_NDK_HOME:-}" ]]; then
  add_ndk_simpleperf_candidate "$ANDROID_NDK_HOME"
fi
if [[ -n "${ANDROID_NDK_ROOT:-}" ]]; then
  add_ndk_simpleperf_candidate "$ANDROID_NDK_ROOT"
fi
local_properties_ndk="$(android_ndk_dir_from_local_properties "$ANDROID_DIR/local.properties")"
if [[ -n "$local_properties_ndk" ]]; then
  add_ndk_simpleperf_candidate "$(resolve_path_against_base "$ANDROID_DIR" "$local_properties_ndk")"
fi
add_simpleperf_from_existing_sdk_root "$ORIGINAL_ANDROID_SDK_ROOT"
add_simpleperf_from_existing_sdk_root "$ORIGINAL_ANDROID_HOME"
add_simpleperf_from_existing_sdk_root "${ANDROID_SDK_ROOT:-}"
add_simpleperf_from_existing_sdk_root "${ANDROID_HOME:-}"
if [[ -n "${HOME:-}" ]]; then
  add_simpleperf_from_sdk_root "$HOME/Android/Sdk"
  add_simpleperf_from_sdk_root "$HOME/Library/Android/sdk"
fi

# Bash 3.2 treats an empty array expansion as unbound under `set -u`.
if [[ "${#candidate_simpleperf_dirs[@]}" -gt 0 ]]; then
  for candidate in "${candidate_simpleperf_dirs[@]}"; do
    candidate_host_simpleperf="$(simpleperf_host_binary_or_empty "$candidate")"
    if [[ -n "$candidate" && -f "$candidate/app_profiler.py" && -n "$candidate_host_simpleperf" ]]; then
      # A direct simpleperf path can itself be a symlink. Resolve it so the
      # parent passed to current app_profiler.py is the actual NDK root.
      simpleperf_dir="$(existing_dir_absolute "$candidate")"
      host_simpleperf="$(simpleperf_host_binary_or_empty "$simpleperf_dir")"
      break
    fi
  done
fi

if [[ -z "$simpleperf_dir" ]]; then
  echo "simpleperf not found. Install a complete NDK simpleperf bundle (app_profiler.py plus the host report binary), then set ANDROID_NDK_HOME / ANDROID_NDK_ROOT or use an NDK under ANDROID_SDK_ROOT, ANDROID_HOME, ~/Android/Sdk, or ~/Library/Android/sdk." >&2
  exit 1
fi

app_profiler="$simpleperf_dir/app_profiler.py"
ndk_path="$(cd -- "$simpleperf_dir/.." && pwd)"
app_profiler_interface="$(detect_app_profiler_interface)"
reporter_help=""
if ! reporter_help="$("$host_simpleperf" report --help 2>&1)"; then
  echo "Unable to inspect the Simpleperf host reporter interface: $host_simpleperf" >&2
  printf '%s\n' "$reporter_help" >&2
  exit 1
fi
if [[ -z "$reporter_help" ]]; then
  echo "Unable to inspect the Simpleperf host reporter interface: $host_simpleperf emitted empty --help output." >&2
  exit 1
fi
if [[ "$reporter_help" == *"--csv"* ]]; then
  REPORTER_SUPPORTS_CSV=1
fi
if [[ "$reporter_help" == *"--csv-separator"* ]]; then
  REPORTER_SUPPORTS_CSV_SEPARATOR=1
fi
if [[ "$reporter_help" == *"--percent-limit"* ]]; then
  REPORTER_SUPPORTS_PERCENT_LIMIT=1
fi

declare -a app_profiler_args=(-p "$PACKAGE" -a "$APP_PROFILER_ACTIVITY" --disable_adb_root)
if [[ "$app_profiler_interface" == "current" ]]; then
  if [[ "$PROFILE_ARCH_EXPLICIT" -eq 1 ]]; then
    echo "--arch is only supported by legacy Simpleperf app_profiler.py releases; the current interface selects the device architecture automatically." >&2
    exit 2
  fi
  PROFILE_ARCH="auto"
  app_profiler_args+=(--ndk_path "$ndk_path")
fi

tmp_dir="$(make_temp_dir openclaw-android-hotspots)"
binary_cache_dir="$tmp_dir/binary_cache"
output_staging_dir=""
capture_perf_data=""

cleanup_hotspots() {
  local exit_status=$?
  if ! restore_legacy_perf_harden; then
    echo "Legacy Simpleperf cleanup could not restore security.perf_harden on device: $DEVICE_SERIAL" >&2
    if [[ "$exit_status" -eq 0 ]]; then
      exit_status=1
    fi
  fi
  rm -rf "$tmp_dir"
  if [[ -n "$output_staging_dir" ]]; then
    rm -rf "$output_staging_dir"
  fi
  if [[ -n "$DEFAULT_OUTPUT_RESERVATION" && ( -f "$DEFAULT_OUTPUT_RESERVATION" || -L "$DEFAULT_OUTPUT_RESERVATION" ) ]]; then
    rm -f -- "$DEFAULT_OUTPUT_RESERVATION"
  fi
  return "$exit_status"
}

trap cleanup_hotspots EXIT
output_staging_dir="$(TMPDIR="$output_parent" make_temp_dir openclaw-android-hotspots-capture)"
capture_perf_data="$output_staging_dir/capture.perf.data"

capture_log="$tmp_dir/capture.log"
dso_csv="$tmp_dir/dso.csv"
symbols_csv="$tmp_dir/symbols.csv"
children_txt="$tmp_dir/children.txt"

cd "$ANDROID_DIR"
if [[ "$INSTALL_BEFORE_CAPTURE" -eq 1 ]]; then
  # Fail before Gradle can install or replace the app when Simpleperf would
  # later refuse the selected rooted adb daemon. Re-check immediately before
  # capture below in case daemon privilege changes during the install.
  require_non_root_adb_daemon
  require_android_sdk_env "$ANDROID_DIR"
  require_executable_file "Gradle wrapper" "$GRADLEW"
  if ! ANDROID_SERIAL="$DEVICE_SERIAL" "$GRADLEW" "$INSTALL_TASK" -Pandroid.injected.device.serial="$DEVICE_SERIAL" --console=plain >"$tmp_dir/install.log" 2>&1; then
    echo "Debug install failed for task $INSTALL_TASK. tail(install.log):" >&2
    tail -n 120 "$tmp_dir/install.log" >&2
    exit 1
  fi
fi

if [[ "$app_profiler_interface" == "legacy" ]]; then
  PROFILE_ARCH="$(resolve_simpleperf_arch "$PROFILE_ARCH")"
  app_profiler_args+=(-nc --arch "$PROFILE_ARCH" --profile_from_launch)
fi

# Upstream app_profiler.py implements --disable_adb_root by actively running
# `adb unroot` when the selected daemon is already root. Refuse that state so a
# local profiling command never changes daemon privilege behind the operator's
# back. Keep this check immediately before capture to minimize the race window.
require_non_root_adb_daemon

if [[ "$app_profiler_interface" == "legacy" ]]; then
  prepare_legacy_perf_harden_restore
fi

# app_profiler.py creates binary_cache/ in its working directory. Keep it in the
# per-run scratch directory and pass it explicitly to the host reporter via
# --symfs so profiles from different devices/runs cannot contaminate each other
# and a local capture never leaves generated binaries in apps/android/.
# Capture into the output directory and publish only after every report validates,
# so failures cannot replace a prior profile or leave partial data at a new path.
cd "$tmp_dir"

app_profiler_args+=(
  -o "$capture_perf_data"
  -r "-e task-clock:u -f 1000 -g --duration $DURATION_SECONDS"
)
capture_status=0
ANDROID_SERIAL="$DEVICE_SERIAL" uv run --no-project python3 "$app_profiler" \
  "${app_profiler_args[@]}" \
  >"$capture_log" 2>&1 || capture_status=$?

restore_status=0
restore_legacy_perf_harden || restore_status=$?

if [[ "$capture_status" -ne 0 ]]; then
  echo "simpleperf capture failed. tail(capture_log):" >&2
  tail -n 120 "$capture_log" >&2
  exit 1
fi
if [[ "$restore_status" -ne 0 ]]; then
  echo "Legacy Simpleperf capture completed, but security.perf_harden could not be restored; refusing to publish perf data." >&2
  exit 1
fi

if [[ ! -s "$capture_perf_data" ]]; then
  echo "simpleperf capture did not produce non-empty perf data: $OUTPUT_PERF_DATA" >&2
  echo "tail(capture_log):" >&2
  tail -n 120 "$capture_log" >&2 || true
  exit 1
fi
if [[ ! -d "$binary_cache_dir" ]]; then
  echo "simpleperf capture did not produce the binary cache required for symbolized reports: $binary_cache_dir" >&2
  echo "tail(capture_log):" >&2
  tail -n 120 "$capture_log" >&2 || true
  exit 1
fi
if ! find "$binary_cache_dir" -type f -size +0c -print -quit | grep -q .; then
  echo "simpleperf capture produced an empty binary cache; refusing to publish unsymbolized perf data: $binary_cache_dir" >&2
  echo "tail(capture_log):" >&2
  tail -n 120 "$capture_log" >&2 || true
  exit 1
fi

csv_report_or_die "dso" "$dso_csv" "$tmp_dir/report-dso.err" \
  -i "$capture_perf_data" \
  --symfs "$binary_cache_dir" \
  --sort dso

csv_report_or_die "dso,symbol" "$symbols_csv" "$tmp_dir/report-symbols.err" \
  -i "$capture_perf_data" \
  --symfs "$binary_cache_dir" \
  --sort dso,symbol

declare -a children_report_args=(
  -i "$capture_perf_data"
  --symfs "$binary_cache_dir"
  --children
  --sort "dso,symbol"
  -n
)
# Text-only reporter generations can predate this optional output filter.
# Omitting it increases report volume but leaves the validation contract intact.
if [[ "$REPORTER_SUPPORTS_PERCENT_LIMIT" -eq 1 ]]; then
  children_report_args+=(--percent-limit 0.2)
fi
percent_report_or_die "children" "$children_txt" "$tmp_dir/report-children.err" \
  "${children_report_args[@]}"

# Publication moves or links the staged inode rather than preserving destination
# permissions. Keep every newly-created profile private, and retain the mode
# captured from an explicit pre-existing output.
if [[ -n "$DEFAULT_OUTPUT_RESERVATION" || -z "$OUTPUT_PERF_DATA_PERMISSIONS" ]]; then
  if ! chmod 600 "$capture_perf_data"; then
    echo "Failed to secure new perf data before publication: $OUTPUT_PERF_DATA" >&2
    exit 1
  fi
elif ! chmod "$OUTPUT_PERF_DATA_PERMISSIONS" "$capture_perf_data"; then
  echo "Failed to preserve existing perf data permissions before publication: $OUTPUT_PERF_DATA" >&2
  exit 1
fi

# Re-check the destination before entering the atomic publication helper in case
# it changed while the device capture was running. The helper repeats this exact
# state check immediately before replacement to close the shell-to-Python gap.
if [[ -d "$OUTPUT_PERF_DATA" ]]; then
  echo "--out became a directory during capture: $OUTPUT_PERF_DATA" >&2
  exit 1
fi
if [[ -L "$OUTPUT_PERF_DATA" ]]; then
  echo "--out became a symlink during capture: $OUTPUT_PERF_DATA" >&2
  exit 1
fi
if [[ -e "$OUTPUT_PERF_DATA" && ! -f "$OUTPUT_PERF_DATA" ]]; then
  echo "--out became a special file during capture: $OUTPUT_PERF_DATA" >&2
  exit 1
fi
publish_expected_state=""
if [[ -n "$OUTPUT_PERF_DATA_STATE" ]]; then
  current_output_state="$(file_state_or_die "$OUTPUT_PERF_DATA")"
  if [[ "$current_output_state" != "$OUTPUT_PERF_DATA_STATE" ]]; then
    echo "--out changed during capture; refusing to replace it: $OUTPUT_PERF_DATA" >&2
    exit 1
  fi
  publish_expected_state="$current_output_state"
fi
publish_error="$tmp_dir/publish.err"
# Unlike mv, neither operation treats a destination directory as a container.
# For a new explicit path, link() provides atomic no-replace publication so a
# competing writer can't have its profile destroyed. Reserved defaults and
# explicit pre-existing outputs retain intentional atomic replacement.
publish_mode="replace"
if [[ -z "$DEFAULT_OUTPUT_RESERVATION" && "$OUTPUT_PERF_DATA_PREEXISTED" -eq 0 ]]; then
  publish_mode="no-replace"
fi
if ! uv run --no-project python3 -c '
import os
import stat
import subprocess
import sys

source_path, destination_path, publish_mode, expected_state = sys.argv[1:]

def command_output(args, *, stdin=None):
    result = subprocess.run(
        args,
        stdin=stdin,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
        text=True,
    )
    if result.returncode != 0:
        return ""
    return result.stdout.rstrip("\n")

def file_metadata(path):
    metadata = command_output(["stat", "-c", "%d:%i:%s:%y:%z", path])
    if not metadata:
        metadata = command_output(["stat", "-f", "%d:%i:%z:%.9Fm:%.9Fc", path])
    if not metadata:
        raise RuntimeError(f"failed to inspect destination metadata: {path}")
    return metadata

def file_state(path):
    path_stat = os.lstat(path)
    if stat.S_ISLNK(path_stat.st_mode) or not stat.S_ISREG(path_stat.st_mode):
        raise RuntimeError(f"destination is not a regular non-symlink file: {path}")
    metadata_before = file_metadata(path)
    with open(path, "rb") as source:
        checksum_output = command_output(["cksum"], stdin=source)
    checksum_parts = checksum_output.split()
    if len(checksum_parts) < 2:
        raise RuntimeError(f"failed to checksum destination: {path}")
    metadata_after = file_metadata(path)
    if metadata_before != metadata_after:
        raise RuntimeError(f"destination changed while its state was inspected: {path}")
    return f"{metadata_after}:{checksum_parts[0]}:{checksum_parts[1]}"

if publish_mode == "no-replace":
    os.link(source_path, destination_path)
    os.unlink(source_path)
else:
    if not expected_state or file_state(destination_path) != expected_state:
        raise RuntimeError(f"destination changed immediately before replacement: {destination_path}")
    os.replace(source_path, destination_path)
' "$capture_perf_data" "$OUTPUT_PERF_DATA" "$publish_mode" "$publish_expected_state" 2>"$publish_error"; then
  echo "Failed to atomically publish perf data; the destination changed or rejected replacement: $OUTPUT_PERF_DATA" >&2
  tail -n 40 "$publish_error" >&2 || true
  exit 1
fi
DEFAULT_OUTPUT_RESERVATION=""

clean_csv() {
  awk -F "$CSV_SEPARATOR" 'BEGIN{print_on=0} $1 == "Overhead"{print_on=1} print_on==1{print}' "$1"
}

print_top_dso() {
  clean_csv "$1" | awk -F "$CSV_SEPARATOR" '
    NR == 1 {
      for (i = 1; i <= NF; i++) {
        col[$i] = i
      }
      overhead = col["Overhead"]
      dso = col["Shared Object"]
      next
    }
    overhead && dso && NF > 0 && $overhead ~ /^[[:space:]]*[0-9]+([.][0-9]+)?%[[:space:]]*$/ && ($overhead + 0) > 0 && ($overhead + 0) <= 100 && $dso != "" && rows < 10 {
      printf "  %s  %s\n", $overhead, $dso
      rows++
    }
  '
}

print_top_symbols() {
  clean_csv "$1" | awk -F "$CSV_SEPARATOR" '
    NR == 1 {
      for (i = 1; i <= NF; i++) {
        col[$i] = i
      }
      overhead = col["Overhead"]
      dso = col["Shared Object"]
      symbol = col["Symbol"]
      next
    }
    overhead && dso && symbol && NF > 0 && $overhead ~ /^[[:space:]]*[0-9]+([.][0-9]+)?%[[:space:]]*$/ && ($overhead + 0) > 0 && ($overhead + 0) <= 100 && $dso != "" && $symbol != "" && rows < 20 {
      printf "  %s  %s :: %s\n", $overhead, $dso, $symbol
      rows++
    }
  '
}

print_app_path_clues() {
  local path="$1"
  local matches=""
  matches="$(
    awk '
      /^[[:space:]]*[0-9]+([.][0-9]+)?%[[:space:]]+[0-9]+([.][0-9]+)?%[[:space:]]+/ {
        children = $1
        self = $2
        sub(/%$/, "", children)
        sub(/%$/, "", self)
        if ((children + 0) <= 100 && (self + 0) <= 100 && ((children + 0) > 0 || (self + 0) > 0)) {
          print
        }
      }
    ' "$path" \
      | grep -E 'androidx\.compose|MainActivity|NodeRuntime|NodeForegroundService|SecurePrefs|WebView|libwebviewchromium' \
      | awk 'NR<=20 {print}' \
      || true
  )"
  if [[ -z "$matches" ]]; then
    echo "  none"
    return 0
  fi
  printf '%s\n' "$matches"
}

echo "device_serial=$DEVICE_SERIAL"
echo "adb_daemon_user=$ADB_DAEMON_USER"
echo "target_package=$PACKAGE"
echo "target_activity=$ACTIVITY"
echo "app_profiler_interface=$app_profiler_interface"
echo "profile_arch=$PROFILE_ARCH"
echo "duration_seconds=$DURATION_SECONDS"
echo "ndk_path=$ndk_path"
echo "reporter_path=$host_simpleperf"
if [[ "$REPORTER_SUPPORTS_CSV_SEPARATOR" -eq 1 ]]; then
  echo "reporter_csv_mode=custom-separator"
elif [[ "$REPORTER_SUPPORTS_CSV" -eq 1 ]]; then
  echo "reporter_csv_mode=legacy-normalized"
else
  echo "reporter_csv_mode=text-normalized"
fi
if [[ "$INSTALL_BEFORE_CAPTURE" -eq 1 ]]; then
  echo "install_task=$INSTALL_TASK"
else
  echo "install_task=skipped"
fi
echo "perf_data=$OUTPUT_PERF_DATA"
echo
echo "top_dso_self:"
print_top_dso "$dso_csv"
echo
echo "top_symbols_self:"
print_top_symbols "$symbols_csv"
echo
echo "app_path_clues_children:"
print_app_path_clues "$children_txt"
