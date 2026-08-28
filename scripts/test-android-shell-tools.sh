#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$ROOT_DIR/apps/android"
TMP_DIR="$(mktemp -d -t openclaw-android-shell-tools.XXXXXX)"
SHELL_TOOLS_BENCHMARK_OUTPUT_RELATIVE="apps/android/benchmark/build/outputs/$(basename -- "$TMP_DIR")"
SHELL_TOOLS_BENCHMARK_OUTPUT_DIR="$ROOT_DIR/$SHELL_TOOLS_BENCHMARK_OUTPUT_RELATIVE"
ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR="$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"
export ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR
ANDROID_BENCHMARK_RESULTS_DIR="$TMP_DIR/benchmark-results"
export ANDROID_BENCHMARK_RESULTS_DIR
declare -a CLEANUP_FILES=()

cleanup() {
  rm -rf "$TMP_DIR" "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"
  if [[ "${#CLEANUP_FILES[@]}" -gt 0 ]]; then
    rm -f "${CLEANUP_FILES[@]}"
  fi
}

trap cleanup EXIT
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

if grep -nE '=~[[:space:]]+[^;]*\(' \
  "$ANDROID_DIR/scripts/android-common.sh" \
  "$ANDROID_DIR/scripts/gradle-with-android-env.sh" \
  "$ANDROID_DIR/scripts/install-debug.sh" \
  "$ANDROID_DIR/scripts/run-debug.sh" \
  "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh"; then
  fail "inline grouped [[ =~ ]] regexes are not parseable by the macOS system Bash 3.2; assign the regex to a variable first"
fi

bash -n \
  "$ANDROID_DIR/scripts/android-common.sh" \
  "$ANDROID_DIR/scripts/gradle-with-android-env.sh" \
  "$ANDROID_DIR/scripts/install-debug.sh" \
  "$ANDROID_DIR/scripts/run-debug.sh" \
  "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh"

"$ANDROID_DIR/scripts/gradle-with-android-env.sh" --help >/dev/null
"$ANDROID_DIR/scripts/install-debug.sh" --help >/dev/null
"$ANDROID_DIR/scripts/run-debug.sh" --help >/dev/null
"$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --help >/dev/null
"$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --help >/dev/null
pnpm android:install -- --help >/dev/null
pnpm android:run -- --help >/dev/null
pnpm android:perf:startup -- --help >/dev/null
pnpm android:perf:hotspots -- --help >/dev/null

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local description="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    fail "$description: expected to find '$needle' in: $haystack"
  fi
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  local description="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    fail "$description: did not expect to find '$needle' in: $haystack"
  fi
}

android_shell_ci_job="$(
  awk '
    /^  android-shell-tools:$/ {
      capture = 1
    }
    capture && /^  [A-Za-z0-9_-]+:$/ && $0 !~ /^  android-shell-tools:$/ {
      exit
    }
    capture {
      print
    }
  ' "$ROOT_DIR/.github/workflows/ci.yml"
)"
assert_contains "$android_shell_ci_job" "uses: astral-sh/setup-uv@" "Android shell-tool CI job"
if ! grep -Eq 'uses: astral-sh/setup-uv@[0-9a-f]{40}[[:space:]]+# v[0-9]' <<<"$android_shell_ci_job"; then
  fail "Android shell-tool CI job must pin setup-uv to a full commit SHA with a version comment"
fi

count_top_level_benchmark_snapshots() {
  local results_dir="$1"
  local snapshot=""
  local count=0

  if [[ ! -d "$results_dir" ]]; then
    printf '0\n'
    return 0
  fi

  for snapshot in "$results_dir"/startup-*.json; do
    if [[ -f "$snapshot" && ! -L "$snapshot" ]]; then
      count=$((count + 1))
    fi
  done
  printf '%s\n' "$count"
}

file_permissions() {
  local path="$1"
  local permissions=""
  if permissions="$(stat -c '%a' "$path" 2>/dev/null)"; then
    :
  elif permissions="$(stat -f '%Lp' "$path")"; then
    :
  else
    fail "failed to inspect file permissions: $path"
  fi
  printf '%s\n' "$permissions"
}

write_fake_adb() {
  local body="$1"
  cat >"$TMP_DIR/adb" <<EOF
#!/usr/bin/env bash
set -euo pipefail
$body
EOF
  chmod +x "$TMP_DIR/adb"
}

write_fake_command() {
  local name="$1"
  local body="$2"
  cat >"$TMP_DIR/$name" <<EOF
#!/usr/bin/env bash
set -euo pipefail
$body
EOF
  chmod +x "$TMP_DIR/$name"
}

write_fake_gradlew() {
  cat >"$TMP_DIR/gradlew" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${ANDROID_SERIAL-}" != "wanted" ]]; then
  echo "unexpected ANDROID_SERIAL: ${ANDROID_SERIAL-}" >&2
  exit 65
fi
printf 'fake_gradlew_args=%s\n' "$*"
case "$*" in
  ":app:installDebug -Pandroid.injected.device.serial=wanted --console=plain")
    exit 0
    ;;
  ":benchmark:installDebug -Pandroid.injected.device.serial=wanted --console=plain")
    exit 0
    ;;
  *)
    echo "unexpected gradlew args: $*" >&2
    exit 64
    ;;
esac
EOF
  chmod +x "$TMP_DIR/gradlew"
}

write_fake_gradle_env_runner() {
  cat >"$TMP_DIR/gradle-env-runner" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'gradle_env_root=%s\n' "${ANDROID_SDK_ROOT-}"
printf 'gradle_env_home=%s\n' "${ANDROID_HOME-}"
printf 'gradle_env_args=%s\n' "$*"
EOF
  chmod +x "$TMP_DIR/gradle-env-runner"
}

write_fake_benchmark_gradlew() {
  cat >"$TMP_DIR/gradlew-benchmark" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${ANDROID_SERIAL-}" != "wanted" ]]; then
  echo "unexpected ANDROID_SERIAL: ${ANDROID_SERIAL-}" >&2
  exit 65
fi
if [[ "$*" != *"-Pandroid.injected.device.serial=wanted"* ]]; then
  echo "missing injected device serial property: $*" >&2
  exit 66
fi
case "$*" in
  *":benchmark:connectedDebugAndroidTest"*)
    mkdir -p "${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:?}/current"
    if [[ -n "${OPENCLAW_FAKE_BENCHMARK_JSON:-}" ]]; then
      cp -- "$OPENCLAW_FAKE_BENCHMARK_JSON" \
        "${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:?}/current/current-benchmarkData.json"
    else
      printf '{}\n' >"${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:?}/current/current-benchmarkData.json"
    fi
    if [[ -n "${OPENCLAW_FAKE_CREATE_AUTO_BASELINE:-}" ]]; then
      printf '{}\n' >"$OPENCLAW_FAKE_CREATE_AUTO_BASELINE"
    fi
    if [[ -n "${OPENCLAW_FAKE_REMOVE_BASELINE:-}" ]]; then
      rm -f -- "$OPENCLAW_FAKE_REMOVE_BASELINE"
    fi
    exit 0
    ;;
  *)
    echo "unexpected benchmark gradlew args: $*" >&2
    exit 64
    ;;
esac
EOF
  chmod +x "$TMP_DIR/gradlew-benchmark"
}

write_fake_bad_benchmark_gradlew() {
  cat >"$TMP_DIR/gradlew-bad-benchmark" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${ANDROID_SERIAL-}" != "wanted" ]]; then
  echo "unexpected ANDROID_SERIAL: ${ANDROID_SERIAL-}" >&2
  exit 65
fi
if [[ "$*" != *"-Pandroid.injected.device.serial=wanted"* ]]; then
  echo "missing injected device serial property: $*" >&2
  exit 66
fi
case "$*" in
  *":benchmark:connectedDebugAndroidTest"*)
    mkdir -p "${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:?}/current"
    printf '{"openclawFakeMissingMetrics":true}\n' >"${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:?}/current/current-benchmarkData.json"
    exit 0
    ;;
  *)
    echo "unexpected bad benchmark gradlew args: $*" >&2
    exit 64
    ;;
esac
EOF
  chmod +x "$TMP_DIR/gradlew-bad-benchmark"
}

write_fake_string_benchmark_gradlew() {
  cat >"$TMP_DIR/gradlew-string-benchmark" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${ANDROID_SERIAL-}" != "wanted" ]]; then
  echo "unexpected ANDROID_SERIAL: ${ANDROID_SERIAL-}" >&2
  exit 65
fi
if [[ "$*" != *"-Pandroid.injected.device.serial=wanted"* ]]; then
  echo "missing injected device serial property: $*" >&2
  exit 66
fi
case "$*" in
  *":benchmark:connectedDebugAndroidTest"*)
    mkdir -p "${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:?}/current"
    printf '{"openclawFakeStringMetrics":true}\n' >"${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:?}/current/current-benchmarkData.json"
    exit 0
    ;;
  *)
    echo "unexpected string benchmark gradlew args: $*" >&2
    exit 64
    ;;
esac
EOF
  chmod +x "$TMP_DIR/gradlew-string-benchmark"
}

write_fake_missing_runs_benchmark_gradlew() {
  cat >"$TMP_DIR/gradlew-missing-runs-benchmark" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${ANDROID_SERIAL-}" != "wanted" ]]; then
  echo "unexpected ANDROID_SERIAL: ${ANDROID_SERIAL-}" >&2
  exit 65
fi
if [[ "$*" != *"-Pandroid.injected.device.serial=wanted"* ]]; then
  echo "missing injected device serial property: $*" >&2
  exit 66
fi
case "$*" in
  *":benchmark:connectedDebugAndroidTest"*)
    mkdir -p "${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:?}/current"
    printf '{"openclawFakeMissingRuns":true}\n' >"${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:?}/current/current-benchmarkData.json"
    exit 0
    ;;
  *)
    echo "unexpected missing-runs benchmark gradlew args: $*" >&2
    exit 64
    ;;
esac
EOF
  chmod +x "$TMP_DIR/gradlew-missing-runs-benchmark"
}

write_fake_invalid_runs_benchmark_gradlew() {
  cat >"$TMP_DIR/gradlew-invalid-runs-benchmark" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${ANDROID_SERIAL-}" != "wanted" ]]; then
  echo "unexpected ANDROID_SERIAL: ${ANDROID_SERIAL-}" >&2
  exit 65
fi
if [[ "$*" != *"-Pandroid.injected.device.serial=wanted"* ]]; then
  echo "missing injected device serial property: $*" >&2
  exit 66
fi
case "$*" in
  *":benchmark:connectedDebugAndroidTest"*)
    mkdir -p "${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:?}/current"
    printf '{"openclawFakeInvalidRuns":true}\n' >"${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:?}/current/current-benchmarkData.json"
    exit 0
    ;;
  *)
    echo "unexpected invalid-runs benchmark gradlew args: $*" >&2
    exit 64
    ;;
esac
EOF
  chmod +x "$TMP_DIR/gradlew-invalid-runs-benchmark"
}

write_fake_bad_device_context_benchmark_gradlew() {
  cat >"$TMP_DIR/gradlew-bad-device-context-benchmark" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${ANDROID_SERIAL-}" != "wanted" ]]; then
  echo "unexpected ANDROID_SERIAL: ${ANDROID_SERIAL-}" >&2
  exit 65
fi
if [[ "$*" != *"-Pandroid.injected.device.serial=wanted"* ]]; then
  echo "missing injected device serial property: $*" >&2
  exit 66
fi
case "$*" in
  *":benchmark:connectedDebugAndroidTest"*)
    mkdir -p "${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:?}/current"
    if [[ "${OPENCLAW_FAKE_MISSING_FINGERPRINT:-0}" == "1" ]]; then
      printf '{"openclawFakeMissingFingerprint":true}\n' >"${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:?}/current/current-benchmarkData.json"
    elif [[ "${OPENCLAW_FAKE_INVALID_SDK:-0}" == "1" ]]; then
      printf '{"openclawFakeInvalidSdk":true}\n' >"${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:?}/current/current-benchmarkData.json"
    else
      printf '{"openclawFakeBadDeviceContext":true}\n' >"${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:?}/current/current-benchmarkData.json"
    fi
    exit 0
    ;;
  *)
    echo "unexpected bad-device-context benchmark gradlew args: $*" >&2
    exit 64
    ;;
esac
EOF
  chmod +x "$TMP_DIR/gradlew-bad-device-context-benchmark"
}

write_fake_duplicate_benchmark_gradlew() {
  cat >"$TMP_DIR/gradlew-duplicate-benchmark" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${ANDROID_SERIAL-}" != "wanted" ]]; then
  echo "unexpected ANDROID_SERIAL: ${ANDROID_SERIAL-}" >&2
  exit 65
fi
if [[ "$*" != *"-Pandroid.injected.device.serial=wanted"* ]]; then
  echo "missing injected device serial property: $*" >&2
  exit 66
fi
case "$*" in
  *":benchmark:connectedDebugAndroidTest"*)
    mkdir -p "${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:?}/current"
    if [[ "${OPENCLAW_FAKE_PARTIAL_DUPLICATE_BENCHMARK:-0}" == "1" ]]; then
      printf '{"openclawFakePartiallyDuplicateMetrics":true}\n' >"${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:?}/current/current-benchmarkData.json"
    else
      printf '{"openclawFakeDuplicateMetrics":true}\n' >"${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:?}/current/current-benchmarkData.json"
    fi
    exit 0
    ;;
  *)
    echo "unexpected duplicate benchmark gradlew args: $*" >&2
    exit 64
    ;;
esac
EOF
  chmod +x "$TMP_DIR/gradlew-duplicate-benchmark"
}

write_fake_multiple_outputs_benchmark_gradlew() {
  cat >"$TMP_DIR/gradlew-multiple-outputs-benchmark" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${ANDROID_SERIAL-}" != "wanted" ]]; then
  echo "unexpected ANDROID_SERIAL: ${ANDROID_SERIAL-}" >&2
  exit 65
fi
if [[ "$*" != *"-Pandroid.injected.device.serial=wanted"* ]]; then
  echo "missing injected device serial property: $*" >&2
  exit 66
fi
case "$*" in
  *":benchmark:connectedDebugAndroidTest"*)
    mkdir -p \
      "${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:?}/first" \
      "${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:?}/second"
    printf '{}\n' >"${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:?}/first/first-benchmarkData.json"
    printf '{}\n' >"${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:?}/second/second-benchmarkData.json"
    exit 0
    ;;
  *)
    echo "unexpected multiple-output benchmark gradlew args: $*" >&2
    exit 64
    ;;
esac
EOF
  chmod +x "$TMP_DIR/gradlew-multiple-outputs-benchmark"
}

write_fake_stale_benchmark_gradlew() {
  cat >"$TMP_DIR/gradlew-stale-benchmark" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${ANDROID_SERIAL-}" != "wanted" ]]; then
  echo "unexpected ANDROID_SERIAL: ${ANDROID_SERIAL-}" >&2
  exit 65
fi
if [[ "$*" != *"-Pandroid.injected.device.serial=wanted"* ]]; then
  echo "missing injected device serial property: $*" >&2
  exit 66
fi
case "$*" in
  *":benchmark:connectedDebugAndroidTest"*)
    exit 0
    ;;
  *)
    echo "unexpected stale benchmark gradlew args: $*" >&2
    exit 64
    ;;
esac
EOF
  chmod +x "$TMP_DIR/gradlew-stale-benchmark"
}

write_fake_same_mtime_benchmark_gradlew() {
  cat >"$TMP_DIR/gradlew-same-mtime-benchmark" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${ANDROID_SERIAL-}" != "wanted" ]]; then
  echo "unexpected ANDROID_SERIAL: ${ANDROID_SERIAL-}" >&2
  exit 65
fi
if [[ "$*" != *"-Pandroid.injected.device.serial=wanted"* ]]; then
  echo "missing injected device serial property: $*" >&2
  exit 66
fi
case "$*" in
  *":benchmark:connectedDebugAndroidTest"*)
    mkdir -p "${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:?}/same-mtime"
    printf '{"openclawFakeSameMtimeFreshOutput":true}\n' >"${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:?}/same-mtime/current-benchmarkData.json"
    touch -t 202401010101 "${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:?}/same-mtime/current-benchmarkData.json"
    exit 0
    ;;
  *)
    echo "unexpected same-mtime benchmark gradlew args: $*" >&2
    exit 64
    ;;
esac
EOF
  chmod +x "$TMP_DIR/gradlew-same-mtime-benchmark"
}

write_fake_identical_benchmark_gradlew() {
  cat >"$TMP_DIR/gradlew-identical-benchmark" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${ANDROID_SERIAL-}" != "wanted" ]]; then
  echo "unexpected ANDROID_SERIAL: ${ANDROID_SERIAL-}" >&2
  exit 65
fi
if [[ "$*" != *"-Pandroid.injected.device.serial=wanted"* ]]; then
  echo "missing injected device serial property: $*" >&2
  exit 66
fi
case "$*" in
  *":benchmark:connectedDebugAndroidTest"*)
    printf '{}\n' >"${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:?}/identical/current-benchmarkData.json"
    touch -t 202401010101 "${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:?}/identical/current-benchmarkData.json"
    exit 0
    ;;
  *)
    echo "unexpected identical benchmark gradlew args: $*" >&2
    exit 64
    ;;
esac
EOF
  chmod +x "$TMP_DIR/gradlew-identical-benchmark"
}

write_fake_legacy_cov_benchmark_gradlew() {
  cat >"$TMP_DIR/gradlew-legacy-cov-benchmark" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${ANDROID_SERIAL-}" != "wanted" ]]; then
  echo "unexpected ANDROID_SERIAL: ${ANDROID_SERIAL-}" >&2
  exit 65
fi
if [[ "$*" != *"-Pandroid.injected.device.serial=wanted"* ]]; then
  echo "missing injected device serial property: $*" >&2
  exit 66
fi
case "$*" in
  *":benchmark:connectedDebugAndroidTest"*)
    mkdir -p "${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:?}/current"
    printf '{"openclawFakeLegacyMissingCov":true}\n' >"${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:?}/current/current-benchmarkData.json"
    exit 0
    ;;
  *)
    echo "unexpected legacy-COV benchmark gradlew args: $*" >&2
    exit 64
    ;;
esac
EOF
  chmod +x "$TMP_DIR/gradlew-legacy-cov-benchmark"
}

write_fake_benchmark_jq() {
  cat >"$TMP_DIR/jq" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${LC_ALL-}" != "C" ]]; then
  echo "unexpected benchmark LC_ALL: ${LC_ALL-}" >&2
  exit 65
fi
if [[ -n "${OPENCLAW_REAL_JQ:-}" ]]; then
  exec "$OPENCLAW_REAL_JQ" "$@"
fi
while [[ "${1-}" == -* ]]; do
  shift
done
query="${1-}"
file="${2-}"
if [[ -z "$query" || -z "$file" || ! -f "$file" ]]; then
  exit 2
fi
if [[ -n "${OPENCLAW_FAKE_MUTATE_BENCHMARK_JSON:-}" && "$file" == "$OPENCLAW_FAKE_MUTATE_BENCHMARK_JSON" ]]; then
  if [[ -n "${OPENCLAW_FAKE_MUTATE_BENCHMARK_MARKER:-}" && ! -e "$OPENCLAW_FAKE_MUTATE_BENCHMARK_MARKER" ]]; then
    printf 'mutated\n' >"$OPENCLAW_FAKE_MUTATE_BENCHMARK_MARKER"
    printf '{"openclawFakeMissingMetrics":true}\n' >"$file"
  fi
fi
if [[ "$query" == *".benchmarks[]?"* && "$query" == *"select(. == 1)"* ]]; then
  if grep -qE '"openclawFake(DuplicateMetrics|PartiallyDuplicateMetrics)":true' "$file"; then
    exit 3
  fi
  printf '1\n'
  exit 0
fi
if grep -q '"openclawFakeMissingMetrics":true' "$file"; then
  case "$query" in
    *".metrics.timeToInitialDisplayMs.median"*)
      exit 3
      ;;
  esac
fi
if grep -q '"openclawFakeStringMetrics":true' "$file"; then
  case "$query" in
    *".metrics.timeToInitialDisplayMs.median"*"numbers"*)
      exit 3
      ;;
    *".metrics.timeToInitialDisplayMs.median"*)
      printf 'not-a-number\n'
      exit 0
      ;;
  esac
fi
if grep -q '"openclawFakeMissingRuns":true' "$file"; then
  case "$query" in
    *".metrics.timeToInitialDisplayMs.runs"*)
      exit 3
      ;;
  esac
fi
if grep -q '"openclawFakeInvalidRuns":true' "$file"; then
  case "$query" in
    *".metrics.timeToInitialDisplayMs.runs"*"all("*)
      exit 3
      ;;
    *".metrics.timeToInitialDisplayMs.runs"*)
      printf '3\n'
      exit 0
      ;;
  esac
fi
if grep -q '"openclawFakeBadDeviceContext":true' "$file"; then
  case "$query" in
    *".context.build.brand"*"strings"*)
      exit 3
      ;;
    *".context.build.brand"*)
      printf '42\n'
      exit 0
      ;;
  esac
fi
if grep -q '"openclawFakeMissingFingerprint":true' "$file"; then
  case "$query" in
    *".context.build.fingerprint"*"strings"*|*"@tsv"*)
      exit 3
      ;;
  esac
fi
if grep -q '"openclawFakeInvalidSdk":true' "$file"; then
  case "$query" in
    *".context.build.version.sdk"*)
      if [[ "$query" == *"floor == ."* ]]; then
        exit 3
      fi
      printf '35.5\n'
      exit 0
      ;;
  esac
fi
if grep -q '"openclawFakeDuplicateMetrics":true' "$file"; then
  case "$query" in
    *".metrics.timeToInitialDisplayMs.median"*"numbers"*)
      printf '120\n121\n'
      exit 0
      ;;
  esac
fi
if [[ "${OPENCLAW_FAKE_INCONSISTENT_STATS:-0}" == "1" ]]; then
  case "$query" in
    *".metrics.timeToInitialDisplayMs.minimum"*)
      printf '130\n'
      exit 0
      ;;
    *".metrics.timeToInitialDisplayMs.maximum"*)
      printf '110\n'
      exit 0
      ;;
  esac
fi
if [[ "${OPENCLAW_FAKE_INCONSISTENT_RUN_BOUNDS:-0}" == "1" ]]; then
  case "$query" in
    *".metrics.timeToInitialDisplayMs.runs"*"| min"*)
      printf '100\n'
      exit 0
      ;;
    *".metrics.timeToInitialDisplayMs.runs"*"| max"*)
      printf '140\n'
      exit 0
      ;;
  esac
fi
if [[ "${OPENCLAW_FAKE_INCONSISTENT_RUN_MEDIAN:-0}" == "1" ]]; then
  case "$query" in
    *".metrics.timeToInitialDisplayMs.runs"*"sort"*"floor"*)
      printf '125\n'
      exit 0
      ;;
  esac
fi
case "$query" in
  *"@tsv"*)
    context_suffix=""
    if [[ "$query" == *".context.build.fingerprint"* ]]; then
      context_suffix=$'\tgoogle/pixel8/current-build'
    fi
    if [[ "$file" == *startup-compatible-missing-context-* && "$query" == *"strings"* ]]; then
      exit 0
    elif [[ "$file" == *startup-compatible-missing-context-* ]]; then
      printf 'Google\tPixel 8\t35%s\n' "$context_suffix"
    elif [[ "$file" == *startup-incompatible-fingerprint-* ]]; then
      if [[ -n "$context_suffix" ]]; then
        printf 'Google\tPixel 8\t35\tgoogle/pixel8/other-build\n'
      else
        printf 'Google\tPixel 8\t35\n'
      fi
    elif [[ "$file" == *startup-incompatible-* ]]; then
      printf 'Other\tDevice\t34%s\n' "$context_suffix"
    else
      printf 'Google\tPixel 8\t35%s\n' "$context_suffix"
    fi
    ;;
  *".context.build.brand"*)
    if [[ "$file" == *startup-incompatible-* ]]; then
      printf 'Other\n'
    else
      printf 'Google\n'
    fi
    ;;
  *".context.build.model"*)
    if [[ "$file" == *startup-incompatible-* ]]; then
      printf 'Device\n'
    else
      printf 'Pixel 8\n'
    fi
    ;;
  *".context.build.fingerprint"*)
    if [[ "$file" == *startup-incompatible-fingerprint-* ]]; then
      printf 'google/pixel8/other-build\n'
    else
      printf 'google/pixel8/current-build\n'
    fi
    ;;
  *".context.build.version.sdk"*)
    if [[ "$file" == *startup-incompatible-* ]]; then
      printf '34\n'
    else
      printf '35\n'
    fi
    ;;
  *".metrics.timeToInitialDisplayMs.median"*)
    if [[ -n "${TMPDIR_FAKE_BASELINE:-}" && "$(basename -- "$file")" == "$(basename -- "$TMPDIR_FAKE_BASELINE")" ]]; then
      printf '100\n'
    elif [[ "$file" == *startup-compatible-zero-median-* || "$file" == *startup-zero-median-* ]]; then
      if [[ "$query" == *"select(. > 0)"* ]]; then
        exit 3
      fi
      printf '0\n'
    elif [[ "$file" == *startup-compatible-missing-context-* ]]; then
      printf '70\n'
    elif [[ "$file" == *startup-compatible-missing-median-* ]]; then
      exit 3
    elif [[ "$file" == *startup-compatible-duplicate-median-* ]]; then
      printf '80\n81\n'
    elif [[ "$file" == *startup-compatible-* ]]; then
      printf '90\n'
    else
      printf '120\n'
    fi
    ;;
  *".metrics.timeToInitialDisplayMs.minimum"*)
    printf '110\n'
    ;;
  *".metrics.timeToInitialDisplayMs.maximum"*)
    printf '130\n'
    ;;
  *".metrics.timeToInitialDisplayMs"*"coefficientOfVariation"*)
    if grep -q '"openclawFakeLegacyMissingCov":true' "$file"; then
      printf '\n'
      exit 0
    fi
    if [[ "${OPENCLAW_FAKE_INVALID_REPORTED_COV:-0}" == "1" ]]; then
      exit 3
    fi
    printf '%s\n' "${OPENCLAW_FAKE_REPORTED_COV:-0.03}"
    ;;
  *".metrics.timeToInitialDisplayMs.runs"*"| min"*)
    printf '110\n'
    ;;
  *".metrics.timeToInitialDisplayMs.runs"*"| max"*)
    printf '130\n'
    ;;
  *".metrics.timeToInitialDisplayMs.runs"*"sort"*"floor"*)
    if [[ -n "${TMPDIR_FAKE_BASELINE:-}" && "$(basename -- "$file")" == "$(basename -- "$TMPDIR_FAKE_BASELINE")" ]]; then
      printf '100\n'
    elif [[ "$file" == *startup-compatible-missing-context-* ]]; then
      printf '70\n'
    elif [[ "$file" == *startup-compatible-* ]]; then
      printf '90\n'
    else
      printf '120\n'
    fi
    ;;
  *".metrics.timeToInitialDisplayMs.runs"*"sqrt"*)
    if grep -q '"openclawFakeLegacyMissingCov":true' "$file"; then
      printf '0.02\n'
    else
      printf '0.03\n'
    fi
    ;;
  *".metrics.timeToInitialDisplayMs.runs"*)
    if [[ "$file" == *startup-compatible-invalid-runs-* ]]; then
      printf '9\n'
    else
      printf '%s\n' "${OPENCLAW_FAKE_RUN_COUNT:-10}"
    fi
    ;;
  *)
    echo "unexpected jq query: $query" >&2
    exit 64
    ;;
esac
EOF
  chmod +x "$TMP_DIR/jq"
}

write_fake_uv_for_hotspots() {
  cat >"$TMP_DIR/uv" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${LC_ALL-}" != "C" ]]; then
  echo "unexpected hotspots LC_ALL: ${LC_ALL-}" >&2
  exit 72
fi

if [[ "${ANDROID_SERIAL-}" != "wanted" ]]; then
  echo "unexpected ANDROID_SERIAL: ${ANDROID_SERIAL-}" >&2
  exit 65
fi

if [[ "${1-}" != "run" || "${2-}" != "--no-project" || "${3-}" != "python3" ]]; then
  echo "unexpected uv args: $*" >&2
  exit 64
fi

if [[ "${4-}" == "-c" ]]; then
  if [[ -n "${OPENCLAW_FAKE_PUBLISH_RACE_OUTPUT:-}" ]]; then
    mkdir -p "$OPENCLAW_FAKE_PUBLISH_RACE_OUTPUT"
  fi
  if [[ -n "${OPENCLAW_FAKE_PUBLISH_RACE_FILE:-}" ]]; then
    printf 'competing perf data\n' >"$OPENCLAW_FAKE_PUBLISH_RACE_FILE"
  fi
  shift 3
  exec python3 "$@"
fi

script="${4-}"
shift 4
if [[ ! -f "$script" ]]; then
  echo "missing python script: $script" >&2
  exit 63
fi

case "$script" in
  */app_profiler.py)
    app_profiler_interface="${OPENCLAW_FAKE_APP_PROFILER_INTERFACE:-legacy}"
    if [[ "${1-}" == "--help" ]]; then
    case "$app_profiler_interface" in
      legacy)
          printf '%s\n' 'usage: app_profiler.py -p APP -a ACTIVITY -nc --arch ARCH --profile_from_launch --disable_adb_root'
          ;;
        current)
          printf '%s\n' 'usage: app_profiler.py -p APP -a ACTIVITY --compile_java_code --disable_adb_root'
          printf '%s\n' '  -a ACTIVITY, --activity ACTIVITY'
          ;;
        unsupported)
          printf '%s\n' 'usage: app_profiler.py -p APP'
          ;;
        *)
          echo "unexpected fake app_profiler interface: $app_profiler_interface" >&2
          exit 64
          ;;
      esac
      exit 0
    fi
    if [[ -n "${OPENCLAW_EXPECTED_PROFILE_CWD_PREFIX:-}" && "$PWD" != "${OPENCLAW_EXPECTED_PROFILE_CWD_PREFIX}"* ]]; then
      echo "unexpected app_profiler cwd: $PWD" >&2
      exit 73
    fi
    output_path=""
    ndk_path=""
    profile_package=""
    profile_activity=""
    profile_arch=""
    profile_from_launch=0
    skip_recompile=0
    compile_java_code=0
    disable_adb_root=0
    record_args=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -p)
          profile_package="${2-}"
          shift 2
          ;;
        -a)
          profile_activity="${2-}"
          shift 2
          ;;
        --arch)
          profile_arch="${2-}"
          shift 2
          ;;
        --profile_from_launch)
          profile_from_launch=1
          shift
          ;;
        -nc|--skip_recompile)
          skip_recompile=1
          shift
          ;;
        --compile_java_code)
          compile_java_code=1
          shift
          ;;
        --disable_adb_root)
          disable_adb_root=1
          shift
          ;;
        -o)
          output_path="${2-}"
          shift 2
          ;;
        --ndk_path)
          ndk_path="${2-}"
          shift 2
          ;;
        -r)
          record_args="${2-}"
          shift 2
          ;;
        *)
          shift
          ;;
      esac
    done
    if [[ -z "$output_path" ]]; then
      echo "missing app_profiler -o path" >&2
      exit 64
    fi
    if [[ -n "${OPENCLAW_EXPECTED_PROFILE_PACKAGE:-}" && "$profile_package" != "$OPENCLAW_EXPECTED_PROFILE_PACKAGE" ]]; then
      echo "unexpected app_profiler package: $profile_package" >&2
      exit 67
    fi
    if [[ -n "${OPENCLAW_EXPECTED_PROFILE_ACTIVITY:-}" && "$profile_activity" != "$OPENCLAW_EXPECTED_PROFILE_ACTIVITY" ]]; then
      echo "unexpected app_profiler activity: $profile_activity" >&2
      exit 68
    fi
    if [[ "$disable_adb_root" -ne 1 ]]; then
      echo "app_profiler capture did not disable adb root" >&2
      exit 82
    fi
    if [[ -n "${OPENCLAW_FAKE_APP_PROFILER_UNROOT_MARKER:-}" && "${OPENCLAW_FAKE_ADB_WHOAMI:-shell}" == "root" ]]; then
      adb unroot
    fi
    case "$app_profiler_interface" in
      legacy)
        if [[ -n "$ndk_path" ]]; then
          echo "legacy app_profiler capture received unsupported --ndk_path: $ndk_path" >&2
          exit 66
        fi
        expected_profile_arch="${OPENCLAW_EXPECTED_PROFILE_ARCH:-arm64}"
        if [[ "$profile_arch" != "$expected_profile_arch" ]]; then
          echo "unexpected app_profiler arch: $profile_arch" >&2
          exit 69
        fi
        if [[ "$profile_from_launch" -ne 1 ]]; then
          echo "app_profiler capture did not use --profile_from_launch" >&2
          exit 71
        fi
	        if [[ "$skip_recompile" -ne 1 ]]; then
	          echo "app_profiler capture did not disable automatic speed recompilation" >&2
	          exit 77
	        fi
        if [[ -n "${OPENCLAW_FAKE_LEGACY_PERF_HARDEN_STATE:-}" ]]; then
          printf '0\n' >"$OPENCLAW_FAKE_LEGACY_PERF_HARDEN_STATE"
        fi
	        ;;
      current)
        if [[ -n "${OPENCLAW_EXPECTED_NDK_PATH:-}" && "$ndk_path" != "$OPENCLAW_EXPECTED_NDK_PATH" ]]; then
          echo "unexpected app_profiler --ndk_path: $ndk_path" >&2
          exit 66
        fi
        if [[ -n "$profile_arch" || "$profile_from_launch" -ne 0 || "$skip_recompile" -ne 0 ]]; then
          echo "current app_profiler capture received legacy-only args" >&2
          exit 79
        fi
        if [[ "$compile_java_code" -ne 0 ]]; then
          echo "current app_profiler capture enabled speed compilation" >&2
          exit 80
        fi
        ;;
      *)
        echo "unexpected capture for fake app_profiler interface: $app_profiler_interface" >&2
        exit 81
        ;;
    esac
    if [[ -n "${OPENCLAW_EXPECTED_RECORD_ARGS:-}" && "$record_args" != "$OPENCLAW_EXPECTED_RECORD_ARGS" ]]; then
      echo "unexpected app_profiler -r args: $record_args" >&2
      exit 70
    fi
    if [[ "${OPENCLAW_FAKE_PARTIAL_CAPTURE_FAIL:-0}" == "1" ]]; then
      printf 'partial perf data\n' >"$output_path"
      echo "simulated capture failure after partial output" >&2
      exit 74
    fi
    if [[ "${OPENCLAW_FAKE_SKIP_PERF_OUTPUT:-0}" == "1" ]]; then
      exit 0
    fi
    if [[ "${OPENCLAW_FAKE_SKIP_BINARY_CACHE:-0}" != "1" ]]; then
      mkdir -p binary_cache
      if [[ "${OPENCLAW_FAKE_EMPTY_BINARY_CACHE:-0}" != "1" ]]; then
        printf 'fake symbols\n' >binary_cache/fake.so
      fi
    fi
    printf 'fake perf data\n' >"$output_path"
    if [[ -n "${OPENCLAW_FAKE_REPLACE_PREEXISTING_OUTPUT:-}" ]]; then
      rm -f -- "$OPENCLAW_FAKE_REPLACE_PREEXISTING_OUTPUT"
      printf 'competing replacement perf data\n' >"$OPENCLAW_FAKE_REPLACE_PREEXISTING_OUTPUT"
    fi
    if [[ -n "${OPENCLAW_FAKE_LEGACY_PERF_HARDEN_AFTER_CAPTURE:-}" && -n "${OPENCLAW_FAKE_LEGACY_PERF_HARDEN_STATE:-}" ]]; then
      printf '%s\n' "$OPENCLAW_FAKE_LEGACY_PERF_HARDEN_AFTER_CAPTURE" >"$OPENCLAW_FAKE_LEGACY_PERF_HARDEN_STATE"
    fi
    ;;
  */report.py)
    if [[ "${OPENCLAW_FAKE_REPORT_PY_IMPORT_FAILURE:-0}" == "1" ]]; then
      echo "ModuleNotFoundError: No module named 'tkinter'" >&2
      exit 78
    fi
    children=0
    report_csv=0
    csv_separator=""
    input_path=""
    report_sort=""
    report_symfs=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -i)
          input_path="${2-}"
          shift 2
          ;;
        --children)
          children=1
          shift
          ;;
        --csv-separator)
          if [[ "${OPENCLAW_FAKE_REPORTER_CSV_SEPARATOR:-1}" == "0" ]]; then
            echo "unknown option --csv-separator" >&2
            exit 76
          fi
          csv_separator="${2-}"
          shift 2
          ;;
        --sort)
          report_sort="${2-}"
          shift 2
          ;;
        --symfs)
          report_symfs="${2-}"
          shift 2
          ;;
        --csv)
          report_csv=1
          shift
          ;;
        -n)
          shift
          ;;
        --percent-limit)
          if [[ "${OPENCLAW_FAKE_REPORTER_PERCENT_LIMIT:-1}" == "0" ]]; then
            echo "unknown option --percent-limit" >&2
            exit 76
          fi
          shift 2
          ;;
        *)
          echo "unexpected report args: $*" >&2
          exit 76
          ;;
      esac
    done
    if [[ "${OPENCLAW_REQUIRE_REPORT_SYMFS:-0}" == "1" ]]; then
      if [[ "$report_symfs" != "$PWD/binary_cache" ]]; then
        echo "unexpected report --symfs path: $report_symfs" >&2
        exit 83
      fi
      if [[ ! -f "$report_symfs/fake.so" ]]; then
        echo "report --symfs path missing captured binaries: $report_symfs" >&2
        exit 84
      fi
    fi
    if [[ -n "${OPENCLAW_EXPECTED_REPORT_INPUT:-}" ]]; then
      expected_report_parent="$(dirname -- "$OPENCLAW_EXPECTED_REPORT_INPUT")"
      case "$input_path" in
        "$expected_report_parent"/openclaw-android-hotspots-capture.*/capture.perf.data)
          ;;
        *)
          echo "unexpected staged report -i path: $input_path" >&2
          exit 71
          ;;
      esac
    fi
    if [[ "$children" -eq 0 ]]; then
      if [[ "${OPENCLAW_FAKE_REPORTER_CSV:-1}" == "0" ]]; then
        if [[ "$report_csv" -ne 0 ]]; then
          echo "unknown option --csv" >&2
          exit 76
        fi
      elif [[ "$report_csv" -ne 1 ]]; then
        echo "missing expected --csv option" >&2
        exit 76
      elif [[ "${OPENCLAW_FAKE_REPORTER_CSV_SEPARATOR:-1}" == "0" ]]; then
        csv_separator=","
      elif [[ "$csv_separator" != $'\x1f' ]]; then
        echo "unexpected report --csv-separator" >&2
        exit 75
      fi
    fi

    emit_csv_header() {
      case "$report_sort" in
        dso)
          printf 'Overhead%sShared Object%sEventCount%sEventName\n' \
            "$csv_separator" "$csv_separator" "$csv_separator"
          ;;
        dso,symbol)
          printf 'Overhead%sShared Object%sSymbol%sEventCount%sEventName\n' \
            "$csv_separator" "$csv_separator" "$csv_separator" "$csv_separator"
          ;;
        *)
          echo "unexpected report sort: $report_sort" >&2
          exit 64
          ;;
      esac
    }

    emit_csv_row() {
      local overhead="$1"
      local dso="$2"
      local symbol="$3"
      case "$report_sort" in
        dso)
          printf '%s%s%s%s620%stask-clock:u\n' \
            "$overhead" "$csv_separator" "$dso" "$csv_separator" "$csv_separator"
          ;;
        dso,symbol)
          printf '%s%s%s%s%s%s620%stask-clock:u\n' \
            "$overhead" "$csv_separator" "$dso" "$csv_separator" "$symbol" "$csv_separator" "$csv_separator"
          ;;
        *)
          echo "unexpected report sort: $report_sort" >&2
          exit 64
          ;;
      esac
    }

    if [[ "$children" -eq 1 ]]; then
      case "${OPENCLAW_FAKE_CHILDREN_MODE:-match}" in
        match)
          printf 'Children  Self  Shared Object  Symbol\n'
          printf '  2.00%%  1.00%%  /data/app/openclaw.apk  MainActivity startup path\n'
          ;;
        none)
          printf 'Children  Self  Shared Object  Symbol\n'
          printf '  2.00%%  1.00%%  /system/lib64/libart.so  Other startup path\n'
          ;;
        empty)
          ;;
        malformed)
          printf 'simpleperf children warning without samples\n'
          ;;
        percent_only)
          printf '  2.00%%  samples lost before report generation\n'
          ;;
        out_of_range)
          printf 'Children  Self  Shared Object  Symbol\n'
          printf '  999.00%%  101.00%%  /data/app/openclaw.apk  MainActivity startup path\n'
          ;;
        zero)
          printf 'Children  Self  Shared Object  Symbol\n'
          printf '  0.00%%  0.00%%  /data/app/openclaw.apk  MainActivity startup path\n'
          ;;
        zero_then_valid)
          printf 'Children  Self  Shared Object  Symbol\n'
          printf '  0.00%%  0.00%%  /data/app/openclaw.apk  MainActivity zero-sample path\n'
          printf '  2.00%%  1.00%%  /system/lib64/libart.so  Other startup path\n'
          ;;
        *)
          echo "unexpected OPENCLAW_FAKE_CHILDREN_MODE: ${OPENCLAW_FAKE_CHILDREN_MODE:-}" >&2
          exit 64
          ;;
      esac
      exit 0
    fi
    if [[ "$report_csv" -eq 0 ]]; then
      case "${OPENCLAW_FAKE_REPORT_MODE:-valid}" in
        valid)
          case "$report_sort" in
            dso)
              printf '%-8s  %s\n' 'Overhead' 'Shared Object'
              printf '%-8s  %s\n' '62.00%' '/system/lib64/libart old.so'
              ;;
            dso,symbol)
              printf '%-8s  %-35s  %s\n' 'Overhead' 'Shared Object' 'Symbol'
              printf '%-8s  %-35s  %s\n' '62.00%' '/system/lib64/libart old.so' 'android::Legacy Symbol(int)'
              ;;
            *)
              echo "unexpected text report sort: $report_sort" >&2
              exit 64
              ;;
          esac
          ;;
        malformed)
          printf '%-8s  %s\n' 'Overhead' 'Shared Object'
          printf '%-8s  %s\n' 'not-a-percent' '/system/lib64/libart.so'
          ;;
        bare_overhead)
          case "$report_sort" in
            dso)
              printf '%-8s  %s\n' 'Overhead' 'Shared Object'
              printf '%-8s  %s\n' '62.00' '/system/lib64/libart.so'
              ;;
            dso,symbol)
              printf '%-8s  %-35s  %s\n' 'Overhead' 'Shared Object' 'Symbol'
              printf '%-8s  %-35s  %s\n' '62.00' '/system/lib64/libart.so' 'artQuickToInterpreterBridge'
              ;;
            *)
              echo "unexpected text report sort: $report_sort" >&2
              exit 64
              ;;
          esac
          ;;
        *)
          echo "unsupported text report fixture mode: ${OPENCLAW_FAKE_REPORT_MODE:-}" >&2
          exit 64
          ;;
      esac
      exit 0
    fi
    case "${OPENCLAW_FAKE_REPORT_MODE:-valid}" in
      empty)
        emit_csv_header
        ;;
      malformed)
        emit_csv_header
        printf '62.00%%\n'
        ;;
      malformed_quotes)
        emit_csv_header
        case "$report_sort" in
          dso)
            printf '62.00%%,"/system/lib64/libart.so\n'
            ;;
          dso,symbol)
            printf '62.00%%,/system/lib64/libart.so,"artQuickToInterpreterBridge\n'
            ;;
          *)
            echo "unexpected malformed-quotes report sort: $report_sort" >&2
            exit 64
            ;;
        esac
        ;;
      noheader)
        printf 'simpleperf report warning without csv output\n'
        ;;
      valid)
        emit_csv_header
        emit_csv_row '62.00%' '/system/lib64/libart.so' 'artQuickToInterpreterBridge'
        ;;
      noisy)
        emit_csv_header
        emit_csv_row '99.00%' '' 'MissingDso'
        emit_csv_row '98.00%' '/bad.so' ''
        emit_csv_row '0.00%' '/zero.so' 'ZeroSample'
        emit_csv_row '62.00%' '/system/lib64/libart.so' 'artQuickToInterpreterBridge'
        ;;
      header_drift)
        emit_csv_header
        printf 'Overhead%sSymbol%sEventCount\n' "$csv_separator" "$csv_separator"
        printf '62.00%%%sNotActuallyADso%s620\n' "$csv_separator" "$csv_separator"
        ;;
      separator_chars)
        emit_csv_header
        if [[ "$csv_separator" == "," ]]; then
          printf '62.00%%,/system/lib64/libart|variant.so,"android::operator|(Flag, Flag)",620,task-clock:u\n'
        else
          emit_csv_row '62.00%' '/system/lib64/libart|variant.so' 'android::operator|(Flag, Flag)'
        fi
        ;;
      dso_only)
        emit_csv_header
        emit_csv_row '62.00%' '/system/lib64/libart.so' ''
        ;;
      bad_overhead)
        emit_csv_header
        emit_csv_row 'not-a-percent' '/system/lib64/libart.so' 'artQuickToInterpreterBridge'
        ;;
      out_of_range)
        emit_csv_header
        emit_csv_row '999.00%' '/system/lib64/libart.so' 'artQuickToInterpreterBridge'
        ;;
      zero)
        emit_csv_header
        emit_csv_row '0.00%' '/system/lib64/libart.so' 'artQuickToInterpreterBridge'
        ;;
      bare_overhead)
        emit_csv_header
        emit_csv_row '62.00' '/system/lib64/libart.so' 'artQuickToInterpreterBridge'
        ;;
      *)
        echo "unexpected OPENCLAW_FAKE_REPORT_MODE: ${OPENCLAW_FAKE_REPORT_MODE:-}" >&2
        exit 64
        ;;
    esac
    ;;
  *)
    echo "unexpected python script: $script" >&2
    exit 64
    ;;
esac
EOF
  chmod +x "$TMP_DIR/uv"
}

write_fake_simpleperf_host_reporter() {
  cat >"$TMP_DIR/simpleperf-host-reporter" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1-}" != "report" ]]; then
  echo "unexpected host simpleperf args: $*" >&2
  exit 64
fi
shift

if [[ "${1-}" == "--help" || "${1-}" == "-h" ]]; then
  if [[ "${OPENCLAW_FAKE_REPORTER_HELP_FAIL:-0}" == "1" ]]; then
    echo "simulated incompatible host reporter" >&2
    exit 88
  fi
  if [[ "${OPENCLAW_FAKE_REPORTER_HELP_EMPTY:-0}" == "1" ]]; then
    exit 0
  fi
  printf '%s\n' 'Usage: simpleperf report [options]'
  if [[ "${OPENCLAW_FAKE_REPORTER_CSV:-1}" != "0" ]]; then
    printf '%s\n' '--csv Report in csv format.'
  fi
  if [[ "${OPENCLAW_FAKE_REPORTER_CSV:-1}" != "0" && "${OPENCLAW_FAKE_REPORTER_CSV_SEPARATOR:-1}" != "0" ]]; then
    printf '%s\n' '--csv-separator <sep> Set separator for csv columns.'
  fi
  if [[ "${OPENCLAW_FAKE_REPORTER_PERCENT_LIMIT:-1}" != "0" ]]; then
    printf '%s\n' '--percent-limit <percent> Set min percentage in report entries.'
  fi
  exit 0
fi

if [[ -n "${OPENCLAW_FAKE_HOST_REPORT_MARKER:-}" ]]; then
  printf 'host reporter used\n' >"$OPENCLAW_FAKE_HOST_REPORT_MARKER"
fi

# The fake uv command emits deterministic report fixtures. Unset the simulated
# old-report.py Tk failure because the production path bypassed report.py.
unset OPENCLAW_FAKE_REPORT_PY_IMPORT_FAILURE
host_binary_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
simpleperf_root="$(cd -- "$host_binary_dir/../../.." && pwd)"
exec uv run --no-project python3 "$simpleperf_root/report.py" "$@"
EOF
  chmod +x "$TMP_DIR/simpleperf-host-reporter"
}

install_fake_simpleperf_host_reporter() {
  local simpleperf_root="$1"
  local host_binary="$simpleperf_root/bin/linux/x86_64/simpleperf"
  mkdir -p "$(dirname -- "$host_binary")"
  cp "$TMP_DIR/simpleperf-host-reporter" "$host_binary"
  chmod +x "$host_binary"
}

run_with_fake_adb() {
  PATH="$TMP_DIR:$PATH" "$@"
}

expect_failure_contains() {
  local expected="$1"
  shift
  local output=""
  if output="$(run_with_fake_adb "$@" 2>&1)"; then
    fail "expected command to fail: $*"
  fi
  assert_contains "$output" "$expected" "failure output"
}

write_fake_adb 'if [[ "${1-}" == "devices" ]]; then
  printf "List of devices attached\n"
  printf "emu-1\tdevice\n"
  printf "phone-2\tdevice\n"
  exit 0
fi
echo "unexpected adb args: $*" >&2
exit 64'
expect_failure_contains "Multiple Android devices connected" "$ANDROID_DIR/scripts/install-debug.sh"
requested_serial="$(run_with_fake_adb bash -c 'source "$1"; resolve_android_serial "$2"' bash "$ANDROID_DIR/scripts/android-common.sh" phone-2)"
if [[ "$requested_serial" != "phone-2" ]]; then
  fail "requested-device selection returned: $requested_serial"
fi

write_fake_adb 'if [[ "${1-}" == "devices" ]]; then
  printf "List of devices attached\n"
  printf "solo-device\tdevice\n"
  exit 0
fi
echo "unexpected adb args: $*" >&2
exit 64'
resolved_serial="$(run_with_fake_adb bash -c 'source "$1"; resolve_android_serial ""' bash "$ANDROID_DIR/scripts/android-common.sh")"
if [[ "$resolved_serial" != "solo-device" ]]; then
  fail "single-device auto-selection returned: $resolved_serial"
fi

write_fake_adb 'if [[ "${1-}" == "devices" ]]; then
  printf "* daemon not running; starting now at tcp:5037\n"
  printf "* daemon started successfully\n"
  printf "List of devices attached\n"
  printf "solo-after-daemon\tdevice\n"
  exit 0
fi
echo "unexpected adb args: $*" >&2
exit 64'
daemon_chatter_serial="$(run_with_fake_adb bash -c 'source "$1"; resolve_android_serial ""' bash "$ANDROID_DIR/scripts/android-common.sh")"
if [[ "$daemon_chatter_serial" != "solo-after-daemon" ]]; then
  fail "daemon-chatter auto-selection returned: $daemon_chatter_serial"
fi

write_fake_adb 'if [[ "${1-}" == "devices" ]]; then
  printf "List of devices attached\r\n"
  printf "wifi-device:5555    device product:openclaw model:Pixel_8 transport_id:7\r\n"
  exit 0
fi
echo "unexpected adb args: $*" >&2
exit 64'
detailed_serial="$(run_with_fake_adb bash -c 'source "$1"; resolve_android_serial ""' bash "$ANDROID_DIR/scripts/android-common.sh")"
if [[ "$detailed_serial" != "wifi-device:5555" ]]; then
  fail "detailed-device auto-selection returned: $detailed_serial"
fi

write_fake_adb 'if [[ "${1-}" == "devices" ]]; then
  printf "List of devices attached\n"
  printf "wifi-device:5555    device product:openclaw model:Pixel_8 transport_id:7\n"
  printf "usb-device          device product:openclaw model:Pixel_7 transport_id:8\n"
  exit 0
fi
echo "unexpected adb args: $*" >&2
exit 64'
detailed_requested_serial="$(run_with_fake_adb bash -c 'source "$1"; resolve_android_serial "$2"' bash "$ANDROID_DIR/scripts/android-common.sh" usb-device)"
if [[ "$detailed_requested_serial" != "usb-device" ]]; then
  fail "detailed requested-device selection returned: $detailed_requested_serial"
fi

write_fake_adb 'if [[ "${1-}" == "devices" ]]; then
  printf "List of devices attached\n"
  exit 0
fi
echo "unexpected adb args: $*" >&2
exit 64'
expect_failure_contains "No connected Android device" bash -c 'source "$1"; resolve_android_serial ""' bash "$ANDROID_DIR/scripts/android-common.sh"

write_fake_adb 'if [[ "${1-}" == "devices" ]]; then
  printf "daemon started successfully\n"
  printf "wanted\tdevice\n"
  exit 0
fi
echo "unexpected adb args: $*" >&2
exit 64'
expect_failure_contains "Unexpected 'adb devices' output" bash -c 'source "$1"; resolve_android_serial ""' bash "$ANDROID_DIR/scripts/android-common.sh"

write_fake_adb 'if [[ "${1-}" == "devices" ]]; then
  echo "adb server is unavailable" >&2
  exit 17
fi
echo "unexpected adb args: $*" >&2
exit 64'
expect_failure_contains "Failed to run 'adb devices'" bash -c 'source "$1"; resolve_android_serial ""' bash "$ANDROID_DIR/scripts/android-common.sh"

fake_local_sdk="$TMP_DIR/local-sdk"
fake_android_dir="$TMP_DIR/fake-android"
mkdir -p "$fake_local_sdk" "$fake_android_dir"
printf 'sdk.dir=%s\n' "$fake_local_sdk" >"$fake_android_dir/local.properties"
local_sdk_env_output="$(
  env -u ANDROID_HOME -u ANDROID_SDK_ROOT HOME="$TMP_DIR/no-home" \
    bash -c 'source "$1"; configure_android_sdk_env "$2"; printf "root=%s home=%s\n" "${ANDROID_SDK_ROOT-}" "${ANDROID_HOME-}"' \
    bash "$ANDROID_DIR/scripts/android-common.sh" "$fake_android_dir"
)"
assert_contains "$local_sdk_env_output" "root=$fake_local_sdk" "local.properties SDK env output"
assert_contains "$local_sdk_env_output" "home=$fake_local_sdk" "local.properties SDK env output"

printf 'sdk\\.dir=%s\n' "$fake_local_sdk" >"$fake_android_dir/local.properties"
escaped_key_local_sdk_env_output="$(
  env -u ANDROID_HOME -u ANDROID_SDK_ROOT HOME="$TMP_DIR/no-home" \
    bash -c 'source "$1"; configure_android_sdk_env "$2"; printf "root=%s home=%s\n" "${ANDROID_SDK_ROOT-}" "${ANDROID_HOME-}"' \
    bash "$ANDROID_DIR/scripts/android-common.sh" "$fake_android_dir"
)"
assert_contains "$escaped_key_local_sdk_env_output" "root=$fake_local_sdk" "escaped-key local.properties SDK env output"
assert_contains "$escaped_key_local_sdk_env_output" "home=$fake_local_sdk" "escaped-key local.properties SDK env output"

fake_last_local_sdk="$TMP_DIR/local-sdk-last"
mkdir -p "$fake_last_local_sdk"
printf 'sdk.dir=%s\nsdk.dir=%s\n' "$fake_local_sdk" "$fake_last_local_sdk" >"$fake_android_dir/local.properties"
duplicate_local_sdk_env_output="$(
  env -u ANDROID_HOME -u ANDROID_SDK_ROOT HOME="$TMP_DIR/no-home" \
    bash -c 'source "$1"; configure_android_sdk_env "$2"; printf "root=%s home=%s\n" "${ANDROID_SDK_ROOT-}" "${ANDROID_HOME-}"' \
    bash "$ANDROID_DIR/scripts/android-common.sh" "$fake_android_dir"
)"
assert_contains "$duplicate_local_sdk_env_output" "root=$fake_last_local_sdk" "duplicate local.properties SDK env output"
assert_contains "$duplicate_local_sdk_env_output" "home=$fake_last_local_sdk" "duplicate local.properties SDK env output"

printf 'sdk.dir=%s\nsdk.dir\n' "$fake_local_sdk" >"$fake_android_dir/local.properties"
bare_duplicate_local_sdk_env_output="$(
  env -u ANDROID_HOME -u ANDROID_SDK_ROOT HOME="$TMP_DIR/no-home" \
    bash -c 'source "$1"; configure_android_sdk_env "$2"; printf "root=%s home=%s\n" "${ANDROID_SDK_ROOT-}" "${ANDROID_HOME-}"' \
    bash "$ANDROID_DIR/scripts/android-common.sh" "$fake_android_dir"
)"
assert_contains "$bare_duplicate_local_sdk_env_output" "root= home=" "bare duplicate local.properties SDK env output"

fake_relative_local_sdk="$fake_android_dir/relative-local-sdk"
mkdir -p "$fake_relative_local_sdk"
printf 'sdk.dir=relative-local-sdk\n' >"$fake_android_dir/local.properties"
relative_local_sdk_env_output="$(
  cd "$TMP_DIR"
  env -u ANDROID_HOME -u ANDROID_SDK_ROOT HOME="$TMP_DIR/no-home" \
    bash -c 'source "$1"; configure_android_sdk_env "$2"; printf "root=%s home=%s\n" "${ANDROID_SDK_ROOT-}" "${ANDROID_HOME-}"' \
    bash "$ANDROID_DIR/scripts/android-common.sh" "$fake_android_dir"
)"
assert_contains "$relative_local_sdk_env_output" "root=$fake_relative_local_sdk" "relative local.properties SDK env output"
assert_contains "$relative_local_sdk_env_output" "home=$fake_relative_local_sdk" "relative local.properties SDK env output"

fake_spaced_sdk="$TMP_DIR/local sdk with spaces"
mkdir -p "$fake_spaced_sdk"
printf '  sdk.dir = %s\n' "${fake_spaced_sdk// /\\ }" >"$fake_android_dir/local.properties"
spaced_sdk_env_output="$(
  env -u ANDROID_HOME -u ANDROID_SDK_ROOT HOME="$TMP_DIR/no-home" \
    bash -c 'source "$1"; configure_android_sdk_env "$2"; printf "root=%s home=%s\n" "${ANDROID_SDK_ROOT-}" "${ANDROID_HOME-}"' \
    bash "$ANDROID_DIR/scripts/android-common.sh" "$fake_android_dir"
)"
assert_contains "$spaced_sdk_env_output" "root=$fake_spaced_sdk" "spaced local.properties SDK env output"
assert_contains "$spaced_sdk_env_output" "home=$fake_spaced_sdk" "spaced local.properties SDK env output"

fake_trailing_space_sdk="$TMP_DIR/local-sdk-with-trailing-space "
mkdir -p "$fake_trailing_space_sdk"
printf 'sdk.dir=%s\n' "$fake_trailing_space_sdk" >"$fake_android_dir/local.properties"
trailing_space_sdk_env_output="$(
  env -u ANDROID_HOME -u ANDROID_SDK_ROOT HOME="$TMP_DIR/no-home" \
    bash -c 'source "$1"; configure_android_sdk_env "$2"; printf "root=<%s> home=<%s>\n" "${ANDROID_SDK_ROOT-}" "${ANDROID_HOME-}"' \
    bash "$ANDROID_DIR/scripts/android-common.sh" "$fake_android_dir"
)"
assert_contains "$trailing_space_sdk_env_output" "root=<$fake_trailing_space_sdk>" "trailing-space local.properties SDK env output"
assert_contains "$trailing_space_sdk_env_output" "home=<$fake_trailing_space_sdk>" "trailing-space local.properties SDK env output"

fake_colon_sdk="$TMP_DIR/local-colon-sdk"
mkdir -p "$fake_colon_sdk"
printf 'sdk.dir: %s\n' "$fake_colon_sdk" >"$fake_android_dir/local.properties"
colon_sdk_env_output="$(
  env -u ANDROID_HOME -u ANDROID_SDK_ROOT HOME="$TMP_DIR/no-home" \
    bash -c 'source "$1"; configure_android_sdk_env "$2"; printf "root=%s home=%s\n" "${ANDROID_SDK_ROOT-}" "${ANDROID_HOME-}"' \
    bash "$ANDROID_DIR/scripts/android-common.sh" "$fake_android_dir"
)"
assert_contains "$colon_sdk_env_output" "root=$fake_colon_sdk" "colon local.properties SDK env output"
assert_contains "$colon_sdk_env_output" "home=$fake_colon_sdk" "colon local.properties SDK env output"

fake_crlf_sdk="$TMP_DIR/local-crlf-sdk"
mkdir -p "$fake_crlf_sdk"
printf 'sdk.dir=%s\r\n' "$fake_crlf_sdk" >"$fake_android_dir/local.properties"
crlf_sdk_env_output="$(
  env -u ANDROID_HOME -u ANDROID_SDK_ROOT HOME="$TMP_DIR/no-home" \
    bash -c 'source "$1"; configure_android_sdk_env "$2"; printf "root=%s home=%s\n" "${ANDROID_SDK_ROOT-}" "${ANDROID_HOME-}"' \
    bash "$ANDROID_DIR/scripts/android-common.sh" "$fake_android_dir"
)"
assert_contains "$crlf_sdk_env_output" "root=$fake_crlf_sdk" "CRLF local.properties SDK env output"
assert_contains "$crlf_sdk_env_output" "home=$fake_crlf_sdk" "CRLF local.properties SDK env output"

fake_whitespace_sdk="$TMP_DIR/local-whitespace-sdk"
mkdir -p "$fake_whitespace_sdk"
printf 'sdk.dir %s\n' "$fake_whitespace_sdk" >"$fake_android_dir/local.properties"
whitespace_sdk_env_output="$(
  env -u ANDROID_HOME -u ANDROID_SDK_ROOT HOME="$TMP_DIR/no-home" \
    bash -c 'source "$1"; configure_android_sdk_env "$2"; printf "root=%s home=%s\n" "${ANDROID_SDK_ROOT-}" "${ANDROID_HOME-}"' \
    bash "$ANDROID_DIR/scripts/android-common.sh" "$fake_android_dir"
)"
assert_contains "$whitespace_sdk_env_output" "root=$fake_whitespace_sdk" "whitespace local.properties SDK env output"
assert_contains "$whitespace_sdk_env_output" "home=$fake_whitespace_sdk" "whitespace local.properties SDK env output"

fake_commented_sdk="$TMP_DIR/local-commented-sdk"
mkdir -p "$fake_commented_sdk"
printf '# sdk.dir=%s\nsdk.dir=%s\n' "$TMP_DIR/ignored-sdk" "$fake_commented_sdk" >"$fake_android_dir/local.properties"
commented_sdk_env_output="$(
  env -u ANDROID_HOME -u ANDROID_SDK_ROOT HOME="$TMP_DIR/no-home" \
    bash -c 'source "$1"; configure_android_sdk_env "$2"; printf "root=%s home=%s\n" "${ANDROID_SDK_ROOT-}" "${ANDROID_HOME-}"' \
    bash "$ANDROID_DIR/scripts/android-common.sh" "$fake_android_dir"
)"
assert_contains "$commented_sdk_env_output" "root=$fake_commented_sdk" "commented local.properties SDK env output"
assert_contains "$commented_sdk_env_output" "home=$fake_commented_sdk" "commented local.properties SDK env output"

fake_escaped_sdk="$TMP_DIR/local:sdk=with\\chars"
mkdir -p "$fake_escaped_sdk"
escaped_sdk_property="${fake_escaped_sdk//\\/\\\\}"
escaped_sdk_property="${escaped_sdk_property//:/\\:}"
escaped_sdk_property="${escaped_sdk_property//=/\\=}"
printf 'sdk.dir=%s\n' "$escaped_sdk_property" >"$fake_android_dir/local.properties"
escaped_sdk_env_output="$(
  env -u ANDROID_HOME -u ANDROID_SDK_ROOT HOME="$TMP_DIR/no-home" \
    bash -c 'source "$1"; configure_android_sdk_env "$2"; printf "root=%s home=%s\n" "${ANDROID_SDK_ROOT-}" "${ANDROID_HOME-}"' \
    bash "$ANDROID_DIR/scripts/android-common.sh" "$fake_android_dir"
)"
assert_contains "$escaped_sdk_env_output" "root=$fake_escaped_sdk" "escaped local.properties SDK env output"
assert_contains "$escaped_sdk_env_output" "home=$fake_escaped_sdk" "escaped local.properties SDK env output"

fake_unicode_sdk="$TMP_DIR/local-sdk-é-火-😀"
mkdir -p "$fake_unicode_sdk"
printf 'sdk.dir=%s/local-sdk-\\u00e9-\\u706b-\\ud83d\\ude00\n' "$TMP_DIR" >"$fake_android_dir/local.properties"
unicode_sdk_env_output="$(
  env -u ANDROID_HOME -u ANDROID_SDK_ROOT HOME="$TMP_DIR/no-home" \
    bash -c 'source "$1"; configure_android_sdk_env "$2"; printf "root=%s home=%s\n" "${ANDROID_SDK_ROOT-}" "${ANDROID_HOME-}"' \
    bash "$ANDROID_DIR/scripts/android-common.sh" "$fake_android_dir"
)"
assert_contains "$unicode_sdk_env_output" "root=$fake_unicode_sdk" "Unicode-escaped local.properties SDK env output"
assert_contains "$unicode_sdk_env_output" "home=$fake_unicode_sdk" "Unicode-escaped local.properties SDK env output"

fake_malformed_unicode_sdk="$TMP_DIR/local-sdk-u12G4"
mkdir -p "$fake_malformed_unicode_sdk"
printf 'sdk.dir=%s/local-sdk-\\u12G4\n' "$TMP_DIR" >"$fake_android_dir/local.properties"
expect_failure_contains "Malformed Unicode escape in local.properties" \
  env -u ANDROID_HOME -u ANDROID_SDK_ROOT HOME="$TMP_DIR/no-home" \
  bash -c 'source "$1"; configure_android_sdk_env "$2"' \
  bash "$ANDROID_DIR/scripts/android-common.sh" "$fake_android_dir"

printf 'sdk.dir=%s/local-sdk-\\u0000\n' "$TMP_DIR" >"$fake_android_dir/local.properties"
expect_failure_contains "Unsupported NUL Unicode escape in local.properties" \
  env -u ANDROID_HOME -u ANDROID_SDK_ROOT HOME="$TMP_DIR/no-home" \
  bash -c 'source "$1"; configure_android_sdk_env "$2"' \
  bash "$ANDROID_DIR/scripts/android-common.sh" "$fake_android_dir"

printf 'sdk.dir=%s/local-sdk-\\ud83d\n' "$TMP_DIR" >"$fake_android_dir/local.properties"
expect_failure_contains "Unsupported unpaired Unicode surrogate escape in local.properties" \
  env -u ANDROID_HOME -u ANDROID_SDK_ROOT HOME="$TMP_DIR/no-home" \
  bash -c 'source "$1"; configure_android_sdk_env "$2"' \
  bash "$ANDROID_DIR/scripts/android-common.sh" "$fake_android_dir"

fake_continued_sdk="$TMP_DIR/local-sdk-continued"
mkdir -p "$fake_continued_sdk"
printf '# ignored comment ending in backslash\\\nsdk.dir=%s/local-sdk-conti\\\n  nued\n' "$TMP_DIR" >"$fake_android_dir/local.properties"
continued_sdk_env_output="$(
  env -u ANDROID_HOME -u ANDROID_SDK_ROOT HOME="$TMP_DIR/no-home" \
    bash -c 'source "$1"; configure_android_sdk_env "$2"; printf "root=%s home=%s\n" "${ANDROID_SDK_ROOT-}" "${ANDROID_HOME-}"' \
    bash "$ANDROID_DIR/scripts/android-common.sh" "$fake_android_dir"
)"
assert_contains "$continued_sdk_env_output" "root=$fake_continued_sdk" "continued local.properties SDK env output"
assert_contains "$continued_sdk_env_output" "home=$fake_continued_sdk" "continued local.properties SDK env output"

fake_local_ndk="$TMP_DIR/local-ndk-with spaces"
mkdir -p "$fake_local_ndk"
printf 'sdk.dir=%s\nndk.dir=%s\n' "$fake_local_sdk" "${fake_local_ndk// /\\ }" >"$fake_android_dir/local.properties"
local_ndk_output="$(
  bash -c 'source "$1"; android_ndk_dir_from_local_properties "$2/local.properties"' \
    bash "$ANDROID_DIR/scripts/android-common.sh" "$fake_android_dir"
)"
if [[ "$local_ndk_output" != "$fake_local_ndk" ]]; then
  fail "local.properties NDK parser returned: $local_ndk_output"
fi
printf 'sdk.dir=%s\n' "$fake_local_sdk" >"$fake_android_dir/local.properties"

stale_sdk_env_output="$(
  env ANDROID_SDK_ROOT="$TMP_DIR/missing-sdk-root" ANDROID_HOME="$fake_local_sdk" HOME="$TMP_DIR/no-home" \
    bash -c 'source "$1"; configure_android_sdk_env "$2"; printf "root=%s home=%s\n" "${ANDROID_SDK_ROOT-}" "${ANDROID_HOME-}"' \
    bash "$ANDROID_DIR/scripts/android-common.sh" "$fake_android_dir"
)"
assert_contains "$stale_sdk_env_output" "root=$fake_local_sdk" "stale SDK env output"
assert_contains "$stale_sdk_env_output" "home=$fake_local_sdk" "stale SDK env output"

fake_root_sdk="$TMP_DIR/root-sdk"
fake_mismatched_home_sdk="$TMP_DIR/mismatched-home-sdk"
mkdir -p "$fake_root_sdk" "$fake_mismatched_home_sdk"
mismatched_sdk_env_output="$(
  env ANDROID_SDK_ROOT="$fake_root_sdk" ANDROID_HOME="$fake_mismatched_home_sdk" HOME="$TMP_DIR/no-home" \
    bash -c 'source "$1"; configure_android_sdk_env "$2"; printf "root=%s home=%s\n" "${ANDROID_SDK_ROOT-}" "${ANDROID_HOME-}"' \
    bash "$ANDROID_DIR/scripts/android-common.sh" "$fake_android_dir"
)"
assert_contains "$mismatched_sdk_env_output" "root=$fake_root_sdk" "mismatched SDK env output"
assert_contains "$mismatched_sdk_env_output" "home=$fake_root_sdk" "mismatched SDK env output"

fake_empty_root_sdk="$TMP_DIR/empty-root-sdk"
fake_home_sdk_with_adb="$TMP_DIR/home-sdk-with-adb"
fake_stale_root_no_adb_bin="$TMP_DIR/stale-root-no-adb-bin"
mkdir -p "$fake_empty_root_sdk" "$fake_home_sdk_with_adb/platform-tools" "$fake_stale_root_no_adb_bin"
touch "$fake_home_sdk_with_adb/platform-tools/adb"
chmod +x "$fake_home_sdk_with_adb/platform-tools/adb"
stale_root_sdk_env_output="$(
  env ANDROID_SDK_ROOT="$fake_empty_root_sdk" ANDROID_HOME="$fake_home_sdk_with_adb" HOME="$TMP_DIR/no-home" PATH="$fake_stale_root_no_adb_bin" \
    "$BASH" -c 'source "$1"; configure_android_sdk_env "$2"; printf "root=%s home=%s adb=%s\n" "${ANDROID_SDK_ROOT-}" "${ANDROID_HOME-}" "$(command -v adb)"' \
    bash "$ANDROID_DIR/scripts/android-common.sh" "$fake_android_dir"
)"
assert_contains "$stale_root_sdk_env_output" "root=$fake_home_sdk_with_adb" "stale root SDK env output"
assert_contains "$stale_root_sdk_env_output" "home=$fake_home_sdk_with_adb" "stale root SDK env output"
assert_contains "$stale_root_sdk_env_output" "adb=$fake_home_sdk_with_adb/platform-tools/adb" "stale root SDK env output"

fake_windows_stale_root_sdk="$TMP_DIR/windows-stale-root-sdk"
fake_windows_home_sdk_with_adb="$TMP_DIR/windows-home-sdk-with-adb"
fake_windows_uname_bin="$TMP_DIR/windows-uname-bin"
mkdir -p "$fake_windows_stale_root_sdk" "$fake_windows_home_sdk_with_adb/platform-tools"
mkdir -p "$fake_windows_uname_bin"
touch "$fake_windows_home_sdk_with_adb/platform-tools/adb.exe"
chmod +x "$fake_windows_home_sdk_with_adb/platform-tools/adb.exe"
cat >"$fake_windows_uname_bin/uname" <<'EOF'
#!/usr/bin/env bash
printf 'MINGW64_NT-10.0\n'
EOF
chmod +x "$fake_windows_uname_bin/uname"
windows_stale_root_sdk_env_output="$(
  env ANDROID_SDK_ROOT="$fake_windows_stale_root_sdk" ANDROID_HOME="$fake_windows_home_sdk_with_adb" HOME="$TMP_DIR/no-home" PATH="$fake_windows_uname_bin:$PATH" \
    bash -c 'source "$1"; configure_android_sdk_env "$2"; printf "root=%s home=%s\n" "${ANDROID_SDK_ROOT-}" "${ANDROID_HOME-}"' \
    bash "$ANDROID_DIR/scripts/android-common.sh" "$fake_android_dir"
)"
assert_contains "$windows_stale_root_sdk_env_output" "root=$fake_windows_home_sdk_with_adb" "Windows stale root SDK env output"
assert_contains "$windows_stale_root_sdk_env_output" "home=$fake_windows_home_sdk_with_adb" "Windows stale root SDK env output"

fake_linux_windows_sdk="$TMP_DIR/linux-windows-sdk"
fake_linux_native_sdk="$TMP_DIR/linux-native-sdk"
fake_linux_uname_bin="$TMP_DIR/linux-uname-bin"
mkdir -p \
  "$fake_linux_windows_sdk/platform-tools" \
  "$fake_linux_native_sdk/platform-tools" \
  "$fake_linux_uname_bin"
touch "$fake_linux_windows_sdk/platform-tools/adb.exe"
touch "$fake_linux_native_sdk/platform-tools/adb"
chmod +x \
  "$fake_linux_windows_sdk/platform-tools/adb.exe" \
  "$fake_linux_native_sdk/platform-tools/adb"
cat >"$fake_linux_uname_bin/uname" <<'EOF'
#!/usr/bin/env bash
printf 'Linux\n'
EOF
chmod +x "$fake_linux_uname_bin/uname"
linux_native_adb_sdk_env_output="$(
  env ANDROID_SDK_ROOT="$fake_linux_windows_sdk" ANDROID_HOME="$fake_linux_native_sdk" HOME="$TMP_DIR/no-home" PATH="$fake_linux_uname_bin:$PATH" \
    bash -c 'source "$1"; configure_android_sdk_env "$2"; printf "root=%s home=%s\n" "${ANDROID_SDK_ROOT-}" "${ANDROID_HOME-}"' \
    bash "$ANDROID_DIR/scripts/android-common.sh" "$fake_android_dir"
)"
assert_contains "$linux_native_adb_sdk_env_output" "root=$fake_linux_native_sdk" "Linux native adb SDK env output"
assert_contains "$linux_native_adb_sdk_env_output" "home=$fake_linux_native_sdk" "Linux native adb SDK env output"

fake_existing_stale_root_sdk="$TMP_DIR/existing-stale-root-sdk"
fake_local_sdk_with_adb="$TMP_DIR/local-sdk-with-adb"
fake_local_no_adb_bin="$TMP_DIR/local-no-adb-bin"
mkdir -p "$fake_existing_stale_root_sdk" "$fake_local_sdk_with_adb/platform-tools" "$fake_local_no_adb_bin"
touch "$fake_local_sdk_with_adb/platform-tools/adb"
chmod +x "$fake_local_sdk_with_adb/platform-tools/adb"
printf 'sdk.dir=%s\n' "$fake_local_sdk_with_adb" >"$fake_android_dir/local.properties"
stale_root_local_adb_env_output="$(
  env -u ANDROID_HOME ANDROID_SDK_ROOT="$fake_existing_stale_root_sdk" HOME="$TMP_DIR/no-home" PATH="$fake_local_no_adb_bin:$PATH" \
    "$BASH" -c 'source "$1"; configure_android_sdk_env "$2"; printf "root=%s home=%s adb=%s\n" "${ANDROID_SDK_ROOT-}" "${ANDROID_HOME-}" "$(command -v adb)"' \
    bash "$ANDROID_DIR/scripts/android-common.sh" "$fake_android_dir"
)"
assert_contains "$stale_root_local_adb_env_output" "root=$fake_local_sdk_with_adb" "stale root local.properties SDK env output"
assert_contains "$stale_root_local_adb_env_output" "home=$fake_local_sdk_with_adb" "stale root local.properties SDK env output"
assert_contains "$stale_root_local_adb_env_output" "adb=$fake_local_sdk_with_adb/platform-tools/adb" "stale root local.properties SDK env output"

fake_relative_env_sdk="$TMP_DIR/relative-env-sdk"
mkdir -p "$fake_relative_env_sdk"
relative_env_sdk_output="$(
  cd "$TMP_DIR"
  env -u ANDROID_HOME ANDROID_SDK_ROOT=relative-env-sdk HOME="$TMP_DIR/no-home" \
    bash -c 'source "$1"; configure_android_sdk_env ""; printf "root=%s home=%s\n" "${ANDROID_SDK_ROOT-}" "${ANDROID_HOME-}"' \
    bash "$ANDROID_DIR/scripts/android-common.sh"
)"
assert_contains "$relative_env_sdk_output" "root=$fake_relative_env_sdk" "relative env SDK output"
assert_contains "$relative_env_sdk_output" "home=$fake_relative_env_sdk" "relative env SDK output"

fake_home="$TMP_DIR/fake-home"
fake_home_sdk="$fake_home/Android/Sdk"
mkdir -p "$fake_home_sdk"
home_sdk_env_output="$(
  env -u ANDROID_HOME -u ANDROID_SDK_ROOT HOME="$fake_home" \
    bash -c 'source "$1"; configure_android_sdk_env ""; printf "root=%s home=%s\n" "${ANDROID_SDK_ROOT-}" "${ANDROID_HOME-}"' \
    bash "$ANDROID_DIR/scripts/android-common.sh"
)"
assert_contains "$home_sdk_env_output" "root=$fake_home_sdk" "home SDK env output"
assert_contains "$home_sdk_env_output" "home=$fake_home_sdk" "home SDK env output"

fake_mac_home="$TMP_DIR/fake-mac-home"
fake_mac_home_sdk="$fake_mac_home/Library/Android/sdk"
mkdir -p "$fake_mac_home_sdk"
mac_home_sdk_env_output="$(
  env -u ANDROID_HOME -u ANDROID_SDK_ROOT HOME="$fake_mac_home" \
    bash -c 'source "$1"; configure_android_sdk_env ""; printf "root=%s home=%s\n" "${ANDROID_SDK_ROOT-}" "${ANDROID_HOME-}"' \
    bash "$ANDROID_DIR/scripts/android-common.sh"
)"
assert_contains "$mac_home_sdk_env_output" "root=$fake_mac_home_sdk" "macOS home SDK env output"
assert_contains "$mac_home_sdk_env_output" "home=$fake_mac_home_sdk" "macOS home SDK env output"

fake_mixed_home="$TMP_DIR/fake-mixed-home"
fake_mixed_incomplete_sdk="$fake_mixed_home/Android/Sdk"
fake_mixed_adb_sdk="$fake_mixed_home/Library/Android/sdk"
mkdir -p "$fake_mixed_incomplete_sdk" "$fake_mixed_adb_sdk/platform-tools"
touch "$fake_mixed_adb_sdk/platform-tools/adb"
chmod +x "$fake_mixed_adb_sdk/platform-tools/adb"
mixed_home_sdk_env_output="$(
  env -u ANDROID_HOME -u ANDROID_SDK_ROOT HOME="$fake_mixed_home" \
    "$BASH" -c 'source "$1"; configure_android_sdk_env ""; printf "root=%s home=%s adb=%s\n" "${ANDROID_SDK_ROOT-}" "${ANDROID_HOME-}" "$(command -v adb)"' \
    bash "$ANDROID_DIR/scripts/android-common.sh"
)"
assert_contains "$mixed_home_sdk_env_output" "root=$fake_mixed_adb_sdk" "mixed home SDK env output"
assert_contains "$mixed_home_sdk_env_output" "home=$fake_mixed_adb_sdk" "mixed home SDK env output"
assert_contains "$mixed_home_sdk_env_output" "adb=$fake_mixed_adb_sdk/platform-tools/adb" "mixed home SDK env output"

unset_home_sdk_env_output="$(
  env -u ANDROID_HOME -u ANDROID_SDK_ROOT -u HOME \
    bash -c 'set -u; source "$1"; configure_android_sdk_env ""; printf "root=%s home=%s\n" "${ANDROID_SDK_ROOT-}" "${ANDROID_HOME-}"' \
    bash "$ANDROID_DIR/scripts/android-common.sh"
)"
assert_contains "$unset_home_sdk_env_output" "root= home=" "unset HOME SDK env output"

windows_drive_path='C:\Users\Kelly\AppData\Local\Android\Sdk'
windows_unc_path='\\android-build\sdks\Android'
windows_local_properties="$TMP_DIR/windows-local.properties"
printf 'sdk.dir=C\\:\\\\Users\\\\Kelly\\\\AppData\\\\Local\\\\Android\\\\Sdk\n' >"$windows_local_properties"
windows_path_output="$(
  bash -c '
    set -euo pipefail
    source "$1"
    printf "drive_absolute=%s\n" "$(make_path_absolute "$2")"
    printf "drive_resolved=%s\n" "$(resolve_path_against_base /repo/apps/android "$2")"
    printf "unc_absolute=%s\n" "$(make_path_absolute "$3")"
    printf "unc_resolved=%s\n" "$(resolve_path_against_base /repo/apps/android "$3")"
    property_path="$(android_sdk_dir_from_local_properties "$4")"
    printf "property_resolved=%s\n" "$(resolve_path_against_base /repo/apps/android "$property_path")"
  ' bash "$ANDROID_DIR/scripts/android-common.sh" "$windows_drive_path" "$windows_unc_path" "$windows_local_properties"
)"
assert_contains "$windows_path_output" "drive_absolute=$windows_drive_path" "Windows drive absolute path output"
assert_contains "$windows_path_output" "drive_resolved=$windows_drive_path" "Windows drive resolved path output"
assert_contains "$windows_path_output" "unc_absolute=$windows_unc_path" "Windows UNC absolute path output"
assert_contains "$windows_path_output" "unc_resolved=$windows_unc_path" "Windows UNC resolved path output"
assert_contains "$windows_path_output" "property_resolved=$windows_drive_path" "Windows local.properties path output"

temp_helper_output="$(
  TMPDIR="$TMP_DIR" bash -c '
    set -euo pipefail
    source "$1"
    temp_file="$(make_temp_file openclaw-helper-test)"
    temp_json="$(make_temp_file_with_suffix openclaw-helper-json .json)"
    temp_dir="$(make_temp_dir openclaw-helper-dir)"
    printf "file=%s\njson=%s\ndir=%s\n" "$temp_file" "$temp_json" "$temp_dir"
  ' bash "$ANDROID_DIR/scripts/android-common.sh"
)"
temp_helper_file="$(printf '%s\n' "$temp_helper_output" | awk -F= '/^file=/{print $2; exit}')"
temp_helper_json="$(printf '%s\n' "$temp_helper_output" | awk -F= '/^json=/{print $2; exit}')"
temp_helper_dir="$(printf '%s\n' "$temp_helper_output" | awk -F= '/^dir=/{print $2; exit}')"
assert_contains "$temp_helper_file" "$TMP_DIR/openclaw-helper-test." "temp helper file path"
assert_contains "$temp_helper_json" "$TMP_DIR/openclaw-helper-json." "temp helper json path"
assert_contains "$temp_helper_json" ".json" "temp helper json suffix"
assert_contains "$temp_helper_dir" "$TMP_DIR/openclaw-helper-dir." "temp helper dir path"
if [[ ! -f "$temp_helper_file" ]]; then
  fail "temp helper file was not created: $temp_helper_file"
fi
if [[ ! -f "$temp_helper_json" ]]; then
  fail "temp helper suffixed file was not created: $temp_helper_json"
fi
if [[ ! -d "$temp_helper_dir" ]]; then
  fail "temp helper directory was not created: $temp_helper_dir"
fi

temp_suffix_race_bin="$TMP_DIR/temp-suffix-race-bin"
temp_suffix_race_marker="$TMP_DIR/temp-suffix-race-marker"
mkdir -p "$temp_suffix_race_bin"
cat >"$temp_suffix_race_bin/mv" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$#" -eq 2 && "$2" == *.json ]]; then
  printf 'attacker-owned\n' >"$2"
  printf 'collision-injected\n' >"${OPENCLAW_TEMP_SUFFIX_RACE_MARKER:?}"
fi
exec "${OPENCLAW_REAL_MV:?}" "$@"
EOF
chmod +x "$temp_suffix_race_bin/mv"
temp_suffix_race_output="$(
  env \
    TMPDIR="$TMP_DIR" \
    PATH="$temp_suffix_race_bin:$PATH" \
    OPENCLAW_REAL_MV="$(command -v mv)" \
    OPENCLAW_TEMP_SUFFIX_RACE_MARKER="$temp_suffix_race_marker" \
    bash -c '
      set -euo pipefail
      source "$1"
      make_temp_file_with_suffix openclaw-helper-race .json
    ' bash "$ANDROID_DIR/scripts/android-common.sh"
)"
if [[ -e "$temp_suffix_race_marker" ]]; then
  fail "temp suffix helper used a clobbering move after the destination collision was injected"
fi
if [[ ! -f "$temp_suffix_race_output" ]]; then
  fail "temp suffix helper did not create an exclusively reserved file: $temp_suffix_race_output"
fi

relative_temp_root="$TMP_DIR/relative-temp-root"
mkdir -p "$relative_temp_root"
relative_temp_helper_output="$(
  cd "$TMP_DIR"
  TMPDIR="relative-temp-root" bash -c '
    set -euo pipefail
    source "$1"
    temp_file="$(make_temp_file openclaw-relative-helper-test)"
    temp_dir="$(make_temp_dir openclaw-relative-helper-dir)"
    printf "file=%s\ndir=%s\n" "$temp_file" "$temp_dir"
  ' bash "$ANDROID_DIR/scripts/android-common.sh"
)"
relative_temp_helper_file="$(printf '%s\n' "$relative_temp_helper_output" | awk -F= '/^file=/{print $2; exit}')"
relative_temp_helper_dir="$(printf '%s\n' "$relative_temp_helper_output" | awk -F= '/^dir=/{print $2; exit}')"
assert_contains "$relative_temp_helper_file" "$relative_temp_root/openclaw-relative-helper-test." "relative TMPDIR helper file path"
assert_contains "$relative_temp_helper_dir" "$relative_temp_root/openclaw-relative-helper-dir." "relative TMPDIR helper dir path"
if [[ "$relative_temp_helper_file" != /* || ! -f "$relative_temp_helper_file" ]]; then
  fail "relative TMPDIR helper did not return an absolute file path: $relative_temp_helper_file"
fi
if [[ "$relative_temp_helper_dir" != /* || ! -d "$relative_temp_helper_dir" ]]; then
  fail "relative TMPDIR helper did not return an absolute directory path: $relative_temp_helper_dir"
fi

expect_failure_contains "Temporary file prefix must be non-empty" \
  bash -c 'source "$1"; make_temp_file ""' bash "$ANDROID_DIR/scripts/android-common.sh"
expect_failure_contains "Temporary file prefix must not contain '/'" \
  bash -c 'source "$1"; make_temp_file "../bad"' bash "$ANDROID_DIR/scripts/android-common.sh"
expect_failure_contains "Temporary file suffix must not contain '/'" \
  bash -c 'source "$1"; make_temp_file_with_suffix openclaw-helper-test "../bad"' bash "$ANDROID_DIR/scripts/android-common.sh"
expect_failure_contains "Temporary directory prefix must not contain '/'" \
  bash -c 'source "$1"; make_temp_dir "../bad"' bash "$ANDROID_DIR/scripts/android-common.sh"

expect_failure_contains "Android SDK not found" \
  env -u ANDROID_HOME -u ANDROID_SDK_ROOT HOME="$TMP_DIR/no-home" \
  "$ANDROID_DIR/scripts/gradle-with-android-env.sh" :app:testDebugUnitTest

fake_sdk_with_adb="$TMP_DIR/sdk-with-adb"
fake_no_adb_bin="$TMP_DIR/no-adb-bin"
mkdir -p "$fake_sdk_with_adb/platform-tools" "$fake_no_adb_bin"
touch "$fake_sdk_with_adb/platform-tools/adb"
chmod +x "$fake_sdk_with_adb/platform-tools/adb"
export ANDROID_SDK_ROOT="$fake_sdk_with_adb"
sdk_path_env_output="$(
  env -u ANDROID_HOME ANDROID_SDK_ROOT="$fake_sdk_with_adb" HOME="$TMP_DIR/no-home" PATH="$fake_no_adb_bin" \
    "$BASH" -c 'source "$1"; configure_android_sdk_env ""; printf "adb=%s\npath=%s\n" "$(command -v adb)" "$PATH"' \
    bash "$ANDROID_DIR/scripts/android-common.sh"
)"
assert_contains "$sdk_path_env_output" "adb=$fake_sdk_with_adb/platform-tools/adb" "SDK platform-tools PATH output"
assert_contains "$sdk_path_env_output" "path=$fake_sdk_with_adb/platform-tools:$fake_no_adb_bin" "SDK platform-tools PATH output"

fake_stale_adb_bin="$TMP_DIR/stale-adb-bin"
mkdir -p "$fake_stale_adb_bin"
touch "$fake_stale_adb_bin/adb"
chmod +x "$fake_stale_adb_bin/adb"
sdk_path_priority_output="$(
  env -u ANDROID_HOME ANDROID_SDK_ROOT="$fake_sdk_with_adb" HOME="$TMP_DIR/no-home" PATH="$fake_stale_adb_bin:$fake_sdk_with_adb/platform-tools" \
    "$BASH" -c 'source "$1"; configure_android_sdk_env ""; printf "adb=%s\npath=%s\n" "$(command -v adb)" "$PATH"' \
    bash "$ANDROID_DIR/scripts/android-common.sh"
)"
assert_contains "$sdk_path_priority_output" "adb=$fake_sdk_with_adb/platform-tools/adb" "SDK platform-tools priority output"
assert_contains "$sdk_path_priority_output" "path=$fake_sdk_with_adb/platform-tools:$fake_stale_adb_bin" "SDK platform-tools priority output"

export ANDROID_SDK_ROOT="$fake_empty_root_sdk"
unset ANDROID_HOME

write_fake_gradle_env_runner
gradle_env_output="$(
  env -u ANDROID_HOME ANDROID_SDK_ROOT="$fake_sdk_with_adb" ANDROID_GRADLEW="$TMP_DIR/gradle-env-runner" \
    "$ANDROID_DIR/scripts/gradle-with-android-env.sh" :app:testDebugUnitTest --stacktrace
)"
assert_contains "$gradle_env_output" "gradle_env_root=$fake_sdk_with_adb" "Gradle env wrapper output"
assert_contains "$gradle_env_output" "gradle_env_home=$fake_sdk_with_adb" "Gradle env wrapper output"
assert_contains "$gradle_env_output" "gradle_env_args=:app:testDebugUnitTest --stacktrace" "Gradle env wrapper output"

pnpm_android_test_output="$(
  env -u ANDROID_HOME ANDROID_SDK_ROOT="$fake_sdk_with_adb" ANDROID_GRADLEW="$TMP_DIR/gradle-env-runner" \
    pnpm android:test -- --info
)"
assert_contains "$pnpm_android_test_output" "gradle_env_root=$fake_sdk_with_adb" "pnpm android:test wrapper output"
assert_contains "$pnpm_android_test_output" "gradle_env_args=:app:testDebugUnitTest --info" "pnpm android:test wrapper output"

pnpm_android_assemble_output="$(
  env -u ANDROID_HOME ANDROID_SDK_ROOT="$fake_sdk_with_adb" ANDROID_GRADLEW="$TMP_DIR/gradle-env-runner" \
    pnpm android:assemble -- --stacktrace
)"
assert_contains "$pnpm_android_assemble_output" "gradle_env_args=:app:assembleDebug --stacktrace" "pnpm android:assemble wrapper output"

pnpm_android_lint_output="$(
  env -u ANDROID_HOME ANDROID_SDK_ROOT="$fake_sdk_with_adb" ANDROID_GRADLEW="$TMP_DIR/gradle-env-runner" \
    pnpm android:lint -- --info
)"
assert_contains "$pnpm_android_lint_output" "gradle_env_args=:app:ktlintCheck :benchmark:ktlintCheck --info" "pnpm android:lint wrapper output"

pnpm_android_format_output="$(
  env -u ANDROID_HOME ANDROID_SDK_ROOT="$fake_sdk_with_adb" ANDROID_GRADLEW="$TMP_DIR/gradle-env-runner" \
    pnpm android:format -- --info
)"
assert_contains "$pnpm_android_format_output" "gradle_env_args=:app:ktlintFormat :benchmark:ktlintFormat --info" "pnpm android:format wrapper output"

pnpm_android_framework_lint_output="$(
  env -u ANDROID_HOME ANDROID_SDK_ROOT="$fake_sdk_with_adb" ANDROID_GRADLEW="$TMP_DIR/gradle-env-runner" \
    pnpm android:lint:android -- --stacktrace
)"
assert_contains "$pnpm_android_framework_lint_output" "gradle_env_args=:app:lintDebug --stacktrace" "pnpm android:lint:android wrapper output"

expect_failure_contains "Gradle wrapper not found" \
  env ANDROID_SDK_ROOT="$fake_sdk_with_adb" ANDROID_GRADLEW="$TMP_DIR/missing-gradlew" \
  "$ANDROID_DIR/scripts/gradle-with-android-env.sh" :app:testDebugUnitTest

write_fake_adb 'if [[ "${1-}" == "devices" ]]; then
  printf "List of devices attached\n"
  printf "offline-one\toffline\n"
  printf "unauth-one\tunauthorized\n"
  printf "perm-one\tno permissions (udev rules missing)\n"
  exit 0
fi
echo "unexpected adb args: $*" >&2
exit 64'
expect_failure_contains "Other adb targets:" bash -c 'source "$1"; resolve_android_serial ""' bash "$ANDROID_DIR/scripts/android-common.sh"
expect_failure_contains "offline-one (offline)" bash -c 'source "$1"; resolve_android_serial ""' bash "$ANDROID_DIR/scripts/android-common.sh"
expect_failure_contains "perm-one (no permissions (udev rules missing))" bash -c 'source "$1"; resolve_android_serial ""' bash "$ANDROID_DIR/scripts/android-common.sh"

write_fake_adb 'if [[ "${1-}" == "devices" ]]; then
  printf "List of devices attached\n"
  printf "wanted\tdevice\n"
  printf "offline-one\toffline\n"
  exit 0
fi
echo "unexpected adb args: $*" >&2
exit 64'
expect_failure_contains "Requested device not connected" "$ANDROID_DIR/scripts/run-debug.sh" --no-install --serial missing
expect_failure_contains "Requested device not connected" pnpm android:install -- --serial missing

write_fake_adb 'if [[ "${1-}" == "devices" ]]; then
  printf "List of devices attached\n"
  printf "wanted\tdevice\n"
  exit 0
fi
if [[ "${1-}" == "-s" && "${2-}" == "wanted" && "${3-}" == "shell" && "${4-}" == "am" && "${5-}" == "start" ]]; then
  if [[ -n "${OPENCLAW_EXPECTED_ADB_COMPONENT_ARG:-}" && "${7-}" != "$OPENCLAW_EXPECTED_ADB_COMPONENT_ARG" ]]; then
    printf "unexpected raw adb component arg: expected=<%s> actual=<%s>\n" "$OPENCLAW_EXPECTED_ADB_COMPONENT_ARG" "${7-}" >&2
    exit 65
  fi
  remote_component="${7-}"
  remote_component="${remote_component//\\$/\$}"
  printf "Starting: Intent { cmp=%s }\n" "$remote_component"
  exit 0
fi
echo "unexpected adb args: $*" >&2
exit 64'
launch_output="$(run_with_fake_adb "$ANDROID_DIR/scripts/run-debug.sh" --no-install --serial wanted)"
assert_contains "$launch_output" "device_serial=wanted" "launch output"
assert_contains "$launch_output" "component=ai.openclaw.android/.MainActivity" "launch output"

custom_launch_output="$(run_with_fake_adb "$ANDROID_DIR/scripts/run-debug.sh" --no-install --serial wanted --package ai.openclaw.custom --activity .CustomActivity)"
assert_contains "$custom_launch_output" "Starting: Intent { cmp=ai.openclaw.custom/.CustomActivity }" "custom launch output"
assert_contains "$custom_launch_output" "device_serial=wanted" "custom launch output"
assert_contains "$custom_launch_output" "component=ai.openclaw.custom/.CustomActivity" "custom launch output"

bare_activity_launch_output="$(run_with_fake_adb "$ANDROID_DIR/scripts/run-debug.sh" --no-install --serial wanted --package ai.openclaw.custom --activity CustomActivity)"
assert_contains "$bare_activity_launch_output" "Starting: Intent { cmp=ai.openclaw.custom/.CustomActivity }" "bare activity launch output"
assert_contains "$bare_activity_launch_output" "component=ai.openclaw.custom/.CustomActivity" "bare activity launch output"

full_activity_launch_output="$(run_with_fake_adb "$ANDROID_DIR/scripts/run-debug.sh" --no-install --serial wanted --package ai.openclaw.custom --activity ai.openclaw.custom.CustomActivity)"
assert_contains "$full_activity_launch_output" "Starting: Intent { cmp=ai.openclaw.custom/ai.openclaw.custom.CustomActivity }" "full activity launch output"
assert_contains "$full_activity_launch_output" "component=ai.openclaw.custom/ai.openclaw.custom.CustomActivity" "full activity launch output"

nested_activity_launch_output="$(
  OPENCLAW_EXPECTED_ADB_COMPONENT_ARG='ai.openclaw.custom/.Outer\$Inner' \
    run_with_fake_adb "$ANDROID_DIR/scripts/run-debug.sh" \
      --no-install \
      --serial wanted \
      --package ai.openclaw.custom \
      --activity 'Outer$Inner'
)"
assert_contains "$nested_activity_launch_output" 'Starting: Intent { cmp=ai.openclaw.custom/.Outer$Inner }' "nested activity launch output"
assert_contains "$nested_activity_launch_output" 'component=ai.openclaw.custom/.Outer$Inner' "nested activity launch output"

write_fake_adb 'if [[ "${1-}" == "devices" ]]; then
  printf "List of devices attached\n"
  printf "wanted\tdevice\n"
  exit 0
fi
if [[ "${1-}" == "-s" && "${2-}" == "wanted" && "${3-}" == "shell" && "${4-}" == "am" && "${5-}" == "start" ]]; then
  printf "Error type 3\n"
  printf "Error: Activity class %s does not exist.\n" "${7-}"
  exit 0
fi
echo "unexpected adb args: $*" >&2
exit 64'
expect_failure_contains "Failed to launch ai.openclaw.android/.MainActivity" \
  "$ANDROID_DIR/scripts/run-debug.sh" --no-install --serial wanted

write_fake_adb 'if [[ "${1-}" == "devices" ]]; then
  printf "List of devices attached\n"
  printf "wanted\tdevice\n"
  exit 0
fi
if [[ "${1-}" == "-s" && "${2-}" == "wanted" && "${3-}" == "shell" && "${4-}" == "am" && "${5-}" == "start" ]]; then
  exit 0
fi
echo "unexpected adb args: $*" >&2
exit 64'
expect_failure_contains "adb reported success without a launch confirmation" \
  "$ANDROID_DIR/scripts/run-debug.sh" --no-install --serial wanted

write_fake_adb 'if [[ "${1-}" == "devices" ]]; then
  printf "List of devices attached\n"
  printf "wanted\tdevice\n"
  exit 0
fi
if [[ "${1-}" == "-s" && "${2-}" == "wanted" && "${3-}" == "shell" && "${4-}" == "am" && "${5-}" == "start" ]]; then
  printf "Activity manager unavailable for %s\n" "${7-}" >&2
  exit 23
fi
echo "unexpected adb args: $*" >&2
exit 64'
expect_failure_contains "Activity manager unavailable for ai.openclaw.android/.MainActivity" \
  "$ANDROID_DIR/scripts/run-debug.sh" --no-install --serial wanted

expect_failure_contains "Gradle wrapper not found" \
  env ANDROID_SDK_ROOT="$fake_empty_root_sdk" ANDROID_GRADLEW="$TMP_DIR/missing-gradlew" \
  "$ANDROID_DIR/scripts/install-debug.sh" --serial wanted

write_fake_gradlew
install_output="$(ANDROID_GRADLEW="$TMP_DIR/gradlew" run_with_fake_adb "$ANDROID_DIR/scripts/install-debug.sh" --serial wanted)"
assert_contains "$install_output" "fake_gradlew_args=:app:installDebug -Pandroid.injected.device.serial=wanted --console=plain" "install output"
assert_contains "$install_output" "device_serial=wanted" "install output"
assert_contains "$install_output" "gradle_task=:app:installDebug" "install output"

custom_task_output="$(ANDROID_GRADLEW="$TMP_DIR/gradlew" run_with_fake_adb "$ANDROID_DIR/scripts/install-debug.sh" --serial wanted --task :benchmark:installDebug)"
assert_contains "$custom_task_output" "fake_gradlew_args=:benchmark:installDebug -Pandroid.injected.device.serial=wanted --console=plain" "custom task install output"
assert_contains "$custom_task_output" "gradle_task=:benchmark:installDebug" "custom task install output"

pnpm_install_output="$(ANDROID_GRADLEW="$TMP_DIR/gradlew" run_with_fake_adb pnpm android:install -- --serial wanted)"
assert_contains "$pnpm_install_output" "fake_gradlew_args=:app:installDebug -Pandroid.injected.device.serial=wanted --console=plain" "pnpm android:install output"
assert_contains "$pnpm_install_output" "device_serial=wanted" "pnpm android:install output"

pnpm_custom_task_install_output="$(ANDROID_GRADLEW="$TMP_DIR/gradlew" run_with_fake_adb pnpm android:install -- --serial wanted --task :benchmark:installDebug)"
assert_contains "$pnpm_custom_task_install_output" "fake_gradlew_args=:benchmark:installDebug -Pandroid.injected.device.serial=wanted --console=plain" "pnpm android:install custom task output"
assert_contains "$pnpm_custom_task_install_output" "gradle_task=:benchmark:installDebug" "pnpm android:install custom task output"

write_fake_adb 'if [[ "${1-}" == "devices" ]]; then
  printf "List of devices attached\n"
  printf "wanted\tdevice\n"
  printf "other\tdevice\n"
  exit 0
fi
echo "unexpected adb args: $*" >&2
exit 64'
install_env_output="$(ANDROID_SERIAL=wanted ANDROID_GRADLEW="$TMP_DIR/gradlew" run_with_fake_adb "$ANDROID_DIR/scripts/install-debug.sh")"
assert_contains "$install_env_output" "fake_gradlew_args=:app:installDebug -Pandroid.injected.device.serial=wanted --console=plain" "ANDROID_SERIAL install output"
assert_contains "$install_env_output" "device_serial=wanted" "ANDROID_SERIAL install output"

pnpm_install_env_output="$(ANDROID_SERIAL=wanted ANDROID_GRADLEW="$TMP_DIR/gradlew" run_with_fake_adb pnpm android:install)"
assert_contains "$pnpm_install_env_output" "fake_gradlew_args=:app:installDebug -Pandroid.injected.device.serial=wanted --console=plain" "ANDROID_SERIAL pnpm android:install output"
assert_contains "$pnpm_install_env_output" "device_serial=wanted" "ANDROID_SERIAL pnpm android:install output"

write_fake_adb 'if [[ "${1-}" == "devices" ]]; then
  printf "List of devices attached\n"
  printf "wanted\tdevice\n"
  exit 0
fi
if [[ "${1-}" == "-s" && "${2-}" == "wanted" && "${3-}" == "shell" && "${4-}" == "am" && "${5-}" == "start" ]]; then
  printf "Starting: Intent { cmp=%s }\n" "${7-}"
  exit 0
fi
echo "unexpected adb args: $*" >&2
exit 64'
run_install_output="$(ANDROID_GRADLEW="$TMP_DIR/gradlew" run_with_fake_adb "$ANDROID_DIR/scripts/run-debug.sh" --serial wanted)"
assert_contains "$run_install_output" "fake_gradlew_args=:app:installDebug -Pandroid.injected.device.serial=wanted --console=plain" "run install output"
assert_contains "$run_install_output" "device_serial=wanted" "run install output"
assert_contains "$run_install_output" "component=ai.openclaw.android/.MainActivity" "run install output"

custom_task_run_output="$(ANDROID_GRADLEW="$TMP_DIR/gradlew" run_with_fake_adb "$ANDROID_DIR/scripts/run-debug.sh" --serial wanted --package ai.openclaw.custom --activity .CustomActivity --task :benchmark:installDebug)"
assert_contains "$custom_task_run_output" "fake_gradlew_args=:benchmark:installDebug -Pandroid.injected.device.serial=wanted --console=plain" "custom task run output"
assert_contains "$custom_task_run_output" "component=ai.openclaw.custom/.CustomActivity" "custom task run output"

write_fake_benchmark_gradlew
real_jq="$(command -v jq)"
write_fake_benchmark_jq
write_fake_command date 'printf "20240101-000000\n"'

androidx_benchmark_fixture="$TMP_DIR/androidx-benchmarkData.json"
cat >"$androidx_benchmark_fixture" <<'EOF'
{
  "context": {
    "build": {
      "brand": "Google",
      "fingerprint": "google/pixel8/current-build",
      "model": "Pixel 8",
      "version": {
        "sdk": 35
      }
    }
  },
  "benchmarks": [
    {
      "name": "startupAndScrollFrameTiming",
      "metrics": {
        "frameDurationCpuMs": {
          "minimum": 5,
          "maximum": 15,
          "median": 10,
          "coefficientOfVariation": 0.1,
          "runs": [5, 6, 7, 8, 9, 11, 12, 13, 14, 15]
        }
      }
    },
    {
      "name": "coldStartup",
      "metrics": {
        "timeToInitialDisplayMs": {
          "minimum": 110,
          "maximum": 130,
          "median": 120,
          "coefficientOfVariation": 0.05826715823167508,
          "runs": [110, 112, 114, 116, 118, 122, 124, 126, 128, 130]
        }
      }
    }
  ]
}
EOF
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"
real_jq_benchmark_output="$(
  OPENCLAW_REAL_JQ="$real_jq" \
    OPENCLAW_FAKE_BENCHMARK_JSON="$androidx_benchmark_fixture" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted 2>&1
)"
assert_contains "$real_jq_benchmark_output" "device_context=Google_Pixel_8_sdk35" "real jq benchmark output"
assert_contains "$real_jq_benchmark_output" "startup.cold.median_ms=120.000 min_ms=110.000 max_ms=130.000 cov=0.0583 runs=10" "real jq benchmark output"
real_jq_benchmark_snapshot="$(printf '%s\n' "$real_jq_benchmark_output" | awk -F= '/^snapshot_json=/{print $2; exit}')"
if [[ -z "$real_jq_benchmark_snapshot" || ! -f "$real_jq_benchmark_snapshot" ]]; then
  fail "real jq benchmark snapshot was not created: $real_jq_benchmark_snapshot"
fi
CLEANUP_FILES+=("$real_jq_benchmark_snapshot")
rm -f "$real_jq_benchmark_snapshot"
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

benchmark_validation_race_json="$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR/current/current-benchmarkData.json"
benchmark_validation_race_marker="$TMP_DIR/benchmark-validation-race-mutated"
benchmark_validation_race_output=""
if ! benchmark_validation_race_output="$(
  OPENCLAW_FAKE_MUTATE_BENCHMARK_JSON="$benchmark_validation_race_json" \
    OPENCLAW_FAKE_MUTATE_BENCHMARK_MARKER="$benchmark_validation_race_marker" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted 2>&1
)"; then
  fail "benchmark did not validate a stable copy of Gradle output before reading metrics: $benchmark_validation_race_output"
fi
assert_contains "$benchmark_validation_race_output" "startup.cold.median_ms=120.000" "validation-race benchmark output"
if [[ -e "$benchmark_validation_race_marker" ]]; then
  fail "benchmark validation read the mutable Gradle output instead of a stable copy"
fi
benchmark_validation_race_snapshot="$(printf '%s\n' "$benchmark_validation_race_output" | awk -F= '/^snapshot_json=/{print $2; exit}')"
if [[ -z "$benchmark_validation_race_snapshot" || ! -f "$benchmark_validation_race_snapshot" ]]; then
  fail "validation-race benchmark snapshot was not created: $benchmark_validation_race_snapshot"
fi
CLEANUP_FILES+=("$benchmark_validation_race_snapshot")
rm -f "$benchmark_validation_race_snapshot"
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

benchmark_results_preflight_dir="$TMP_DIR/benchmark-results-preflight"
benchmark_results_preflight_gradle_marker="$TMP_DIR/benchmark-results-preflight-gradle-called"
mkdir -p "$benchmark_results_preflight_dir"
real_mktemp="$(command -v mktemp)"
write_fake_command mktemp '
case "${1-}" in
  "$OPENCLAW_FAKE_RESULTS_PREFLIGHT_DIR"/startup-*.XXXXXX)
    echo "fake benchmark results reservation failure" >&2
    exit 73
    ;;
esac
exec "$OPENCLAW_REAL_MKTEMP" "$@"'
write_fake_command gradlew-results-preflight '
printf "called\n" >"$OPENCLAW_FAKE_GRADLE_MARKER"
exec "$OPENCLAW_FAKE_BENCHMARK_GRADLEW" "$@"'
expect_failure_contains "fake benchmark results reservation failure" \
  env \
    OPENCLAW_FAKE_RESULTS_PREFLIGHT_DIR="$benchmark_results_preflight_dir" \
    OPENCLAW_FAKE_GRADLE_MARKER="$benchmark_results_preflight_gradle_marker" \
    OPENCLAW_FAKE_BENCHMARK_GRADLEW="$TMP_DIR/gradlew-benchmark" \
    OPENCLAW_REAL_MKTEMP="$real_mktemp" \
    ANDROID_BENCHMARK_RESULTS_DIR="$benchmark_results_preflight_dir" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew-results-preflight" \
    "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted
if [[ -e "$benchmark_results_preflight_gradle_marker" ]]; then
  fail "benchmark ran Gradle before confirming that its results snapshot could be reserved"
fi
rm -f "$TMP_DIR/mktemp" "$TMP_DIR/gradlew-results-preflight"

concurrent_benchmark_root="$TMP_DIR/concurrent-benchmarks"
mkdir -p "$concurrent_benchmark_root"
concurrent_benchmark_one_status=0
concurrent_benchmark_two_status=0
(
  ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR="$concurrent_benchmark_root/one-outputs" \
    ANDROID_BENCHMARK_RESULTS_DIR="$concurrent_benchmark_root/one-results" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted \
    >"$concurrent_benchmark_root/one.log" 2>&1
) &
concurrent_benchmark_one_pid=$!
(
  ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR="$concurrent_benchmark_root/two-outputs" \
    ANDROID_BENCHMARK_RESULTS_DIR="$concurrent_benchmark_root/two-results" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted \
    >"$concurrent_benchmark_root/two.log" 2>&1
) &
concurrent_benchmark_two_pid=$!
wait "$concurrent_benchmark_one_pid" || concurrent_benchmark_one_status=$?
wait "$concurrent_benchmark_two_pid" || concurrent_benchmark_two_status=$?
if [[ "$concurrent_benchmark_one_status" -ne 0 || "$concurrent_benchmark_two_status" -ne 0 ]]; then
  echo "Concurrent benchmark one output:" >&2
  cat "$concurrent_benchmark_root/one.log" >&2
  echo "Concurrent benchmark two output:" >&2
  cat "$concurrent_benchmark_root/two.log" >&2
  fail "isolated concurrent benchmarks failed: one=$concurrent_benchmark_one_status two=$concurrent_benchmark_two_status"
fi
assert_contains "$(cat "$concurrent_benchmark_root/one.log")" "startup.cold.median_ms=120.000" "first concurrent benchmark output"
assert_contains "$(cat "$concurrent_benchmark_root/two.log")" "startup.cold.median_ms=120.000" "second concurrent benchmark output"

future_stale_output_dir="$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR/future-stale"
mkdir -p "$future_stale_output_dir"
printf '{"openclawFakeMissingMetrics":true}\n' >"$future_stale_output_dir/stale-benchmarkData.json"
touch -t 203001010101 "$future_stale_output_dir/stale-benchmarkData.json"
future_stale_benchmark_output="$(ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted 2>&1)"
assert_contains "$future_stale_benchmark_output" "startup.cold.median_ms=120.000" "future-stale benchmark output"
future_stale_benchmark_snapshot="$(printf '%s\n' "$future_stale_benchmark_output" | awk -F= '/^snapshot_json=/{print $2; exit}')"
if [[ -z "$future_stale_benchmark_snapshot" || ! -f "$future_stale_benchmark_snapshot" ]]; then
  fail "future-stale benchmark snapshot was not created: $future_stale_benchmark_snapshot"
fi
CLEANUP_FILES+=("$future_stale_benchmark_snapshot")
rm -f "$future_stale_benchmark_snapshot"
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

benchmark_relative_tmp_dir="$TMP_DIR/benchmark-relative-tmp"
mkdir -p "$benchmark_relative_tmp_dir"
relative_tmp_benchmark_output="$(
  cd "$TMP_DIR"
  TMPDIR="benchmark-relative-tmp" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted 2>&1
)"
assert_contains "$relative_tmp_benchmark_output" "startup.cold.median_ms=120.000" "relative TMPDIR benchmark output"
relative_tmp_benchmark_snapshot="$(printf '%s\n' "$relative_tmp_benchmark_output" | awk -F= '/^snapshot_json=/{print $2; exit}')"
if [[ -z "$relative_tmp_benchmark_snapshot" || ! -f "$relative_tmp_benchmark_snapshot" ]]; then
  fail "relative TMPDIR benchmark snapshot was not created: $relative_tmp_benchmark_snapshot"
fi
CLEANUP_FILES+=("$relative_tmp_benchmark_snapshot")
rm -f "$relative_tmp_benchmark_snapshot"
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

benchmark_results_tmpdir="$TMP_DIR/benchmark-results-as-tmpdir"
benchmark_results_tmpdir_outputs="$TMP_DIR/benchmark-results-as-tmpdir-outputs"
mkdir -p "$benchmark_results_tmpdir"
real_find="$(command -v find)"
write_fake_command find '
if [[ "${1-}" == "-H" && "${2-}" == "$OPENCLAW_FAKE_RESULTS_TMPDIR" ]]; then
  has_prune=0
  for arg in "$@"; do
    if [[ "$arg" == "-prune" ]]; then
      has_prune=1
      break
    fi
  done
  if [[ "$has_prune" -ne 1 ]]; then
    echo "benchmark baseline scan did not prune its scratch tree" >&2
    exit 73
  fi
fi
exec "$OPENCLAW_REAL_FIND" "$@"'
benchmark_results_tmpdir_output="$(
  TMPDIR="$benchmark_results_tmpdir" \
    OPENCLAW_FAKE_RESULTS_TMPDIR="$benchmark_results_tmpdir" \
    OPENCLAW_REAL_FIND="$real_find" \
    ANDROID_BENCHMARK_RESULTS_DIR="$benchmark_results_tmpdir" \
    ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR="$benchmark_results_tmpdir_outputs" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted 2>&1
)"
assert_contains "$benchmark_results_tmpdir_output" "startup.cold.median_ms=120.000" "results-as-TMPDIR benchmark output"
benchmark_results_tmpdir_snapshot="$(printf '%s\n' "$benchmark_results_tmpdir_output" | awk -F= '/^snapshot_json=/{print $2; exit}')"
if [[ -z "$benchmark_results_tmpdir_snapshot" || ! -f "$benchmark_results_tmpdir_snapshot" ]]; then
  fail "results-as-TMPDIR benchmark snapshot was not created: $benchmark_results_tmpdir_snapshot"
fi
rm -f "$TMP_DIR/find" "$benchmark_results_tmpdir_snapshot"
rm -rf "$benchmark_results_tmpdir_outputs"

benchmark_baseline="$TMP_DIR/baseline.json"
printf '{}\n' >"$benchmark_baseline"
benchmark_output="$(TMPDIR_FAKE_BASELINE="$benchmark_baseline" ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted --baseline "$benchmark_baseline" 2>&1)"
assert_contains "$benchmark_output" "device_serial=wanted" "benchmark output"
assert_contains "$benchmark_output" "device_context=Google_Pixel_8_sdk35" "benchmark output"
assert_contains "$benchmark_output" "startup.cold.median_ms=120.000" "benchmark output"
assert_contains "$benchmark_output" "cov=0.0300" "benchmark serialized COV output"
assert_contains "$benchmark_output" "baseline_json=$benchmark_baseline" "benchmark output"
assert_contains "$benchmark_output" "baseline_median_ms=100 delta_ms=20.000 delta_pct=20.00%" "benchmark output"
benchmark_snapshot="$(printf '%s\n' "$benchmark_output" | awk -F= '/^snapshot_json=/{print $2; exit}')"
if [[ -z "$benchmark_snapshot" || ! -f "$benchmark_snapshot" ]]; then
  fail "benchmark snapshot was not created: $benchmark_snapshot"
fi
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

volatile_benchmark_baseline="$TMP_DIR/volatile-baseline.json"
printf '{}\n' >"$volatile_benchmark_baseline"
volatile_benchmark_output="$(
  TMPDIR="$TMP_DIR" \
    TMPDIR_FAKE_BASELINE="$volatile_benchmark_baseline" \
    OPENCLAW_FAKE_REMOVE_BASELINE="$volatile_benchmark_baseline" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" \
      --serial wanted \
      --baseline "$volatile_benchmark_baseline" \
      2>&1
)"
if [[ -e "$volatile_benchmark_baseline" ]]; then
  fail "volatile benchmark baseline was not removed during the simulated device run"
fi
if compgen -G "$TMP_DIR/openclaw-android-benchmark-baseline.*" >/dev/null; then
  fail "volatile benchmark run leaked its baseline snapshot directory"
fi
assert_contains "$volatile_benchmark_output" "baseline_json=$volatile_benchmark_baseline" "volatile baseline output"
assert_contains "$volatile_benchmark_output" "baseline_median_ms=100 delta_ms=20.000 delta_pct=20.00%" "volatile baseline output"
volatile_benchmark_snapshot="$(printf '%s\n' "$volatile_benchmark_output" | awk -F= '/^snapshot_json=/{print $2; exit}')"
if [[ -z "$volatile_benchmark_snapshot" || ! -f "$volatile_benchmark_snapshot" ]]; then
  fail "volatile-baseline benchmark snapshot was not created: $volatile_benchmark_snapshot"
fi
CLEANUP_FILES+=("$volatile_benchmark_snapshot")
rm -f "$volatile_benchmark_snapshot"
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

mutating_benchmark_baseline="$TMP_DIR/mutating-baseline.json"
mutating_benchmark_gradle_marker="$TMP_DIR/mutating-baseline-gradle-called"
printf '{}\n' >"$mutating_benchmark_baseline"
real_cp="$(command -v cp)"
write_fake_command cp '
source_path="${1-}"
destination_path="${2-}"
if [[ "$source_path" == "--" ]]; then
  source_path="${2-}"
  destination_path="${3-}"
fi
"$OPENCLAW_REAL_CP" -- "$source_path" "$destination_path"
if [[ "$source_path" == "$OPENCLAW_FAKE_MUTATING_BASELINE" ]]; then
  printf "{\"openclawFakeMissingMetrics\":true}\n" >"$source_path"
fi'
write_fake_command gradlew-mutating-baseline '
printf "called\n" >"$OPENCLAW_FAKE_GRADLE_MARKER"
exec "$OPENCLAW_FAKE_BENCHMARK_GRADLEW" "$@"'
expect_failure_contains "Explicit benchmark baseline changed while it was being copied" \
  env \
    OPENCLAW_REAL_CP="$real_cp" \
    OPENCLAW_FAKE_MUTATING_BASELINE="$mutating_benchmark_baseline" \
    OPENCLAW_FAKE_GRADLE_MARKER="$mutating_benchmark_gradle_marker" \
    OPENCLAW_FAKE_BENCHMARK_GRADLEW="$TMP_DIR/gradlew-benchmark" \
    TMPDIR_FAKE_BASELINE="$mutating_benchmark_baseline" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew-mutating-baseline" \
    "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" \
      --serial wanted \
      --baseline "$mutating_benchmark_baseline"
if [[ -e "$mutating_benchmark_gradle_marker" ]]; then
  fail "benchmark ran Gradle after its explicit baseline changed during snapshotting"
fi
rm -f "$TMP_DIR/cp" "$TMP_DIR/gradlew-mutating-baseline"

write_fake_legacy_cov_benchmark_gradlew
legacy_cov_output="$(ANDROID_GRADLEW="$TMP_DIR/gradlew-legacy-cov-benchmark" run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted 2>&1)"
assert_contains "$legacy_cov_output" "cov=0.0200" "legacy benchmark computed COV output"
legacy_cov_snapshot="$(printf '%s\n' "$legacy_cov_output" | awk -F= '/^snapshot_json=/{print $2; exit}')"
if [[ -z "$legacy_cov_snapshot" || ! -f "$legacy_cov_snapshot" ]]; then
  fail "legacy benchmark snapshot was not created: $legacy_cov_snapshot"
fi
CLEANUP_FILES+=("$legacy_cov_snapshot")
rm -f "$legacy_cov_snapshot"
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

benchmark_incompatible_baseline="$TMP_DIR/startup-incompatible-explicit-baseline.json"
printf '{}\n' >"$benchmark_incompatible_baseline"
benchmark_incompatible_output="$(TMPDIR_FAKE_BASELINE="$benchmark_incompatible_baseline" ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted --baseline "$benchmark_incompatible_baseline" 2>&1)"
assert_contains "$benchmark_incompatible_output" "Warning: baseline device context differs from current run (Google Pixel 8 sdk=35)." "incompatible explicit baseline output"
assert_contains "$benchmark_incompatible_output" "baseline_json=$benchmark_incompatible_baseline" "incompatible explicit baseline output"
assert_contains "$benchmark_incompatible_output" "baseline_median_ms=100 delta_ms=20.000 delta_pct=20.00%" "incompatible explicit baseline output"
benchmark_incompatible_snapshot="$(printf '%s\n' "$benchmark_incompatible_output" | awk -F= '/^snapshot_json=/{print $2; exit}')"
if [[ -z "$benchmark_incompatible_snapshot" || ! -f "$benchmark_incompatible_snapshot" ]]; then
  fail "incompatible explicit baseline snapshot was not created: $benchmark_incompatible_snapshot"
fi
CLEANUP_FILES+=("$benchmark_incompatible_baseline" "$benchmark_incompatible_snapshot")
rm -f "$benchmark_incompatible_baseline" "$benchmark_incompatible_snapshot"
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

benchmark_collision_output="$(TMPDIR_FAKE_BASELINE="$benchmark_baseline" ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted --baseline "$benchmark_baseline" 2>&1)"
benchmark_collision_snapshot="$(printf '%s\n' "$benchmark_collision_output" | awk -F= '/^snapshot_json=/{print $2; exit}')"
if [[ -z "$benchmark_collision_snapshot" || ! -f "$benchmark_collision_snapshot" ]]; then
  fail "second benchmark snapshot was not created: $benchmark_collision_snapshot"
fi
if [[ "$benchmark_collision_snapshot" == "$benchmark_snapshot" ]]; then
  fail "benchmark snapshots collided under same-second timestamp: $benchmark_snapshot"
fi
CLEANUP_FILES+=("$benchmark_snapshot" "$benchmark_collision_snapshot")
rm -f "$benchmark_snapshot" "$benchmark_collision_snapshot"
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

benchmark_publish_results_dir="$TMP_DIR/benchmark-publish-results"
benchmark_publish_race_bin="$TMP_DIR/benchmark-publish-race-bin"
benchmark_publish_race_marker="$TMP_DIR/benchmark-publish-race-marker"
mkdir -p "$benchmark_publish_results_dir" "$benchmark_publish_race_bin"
cat >"$benchmark_publish_race_bin/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
destination=""
for argument in "$@"; do
  destination="$argument"
done
case "$destination" in
  "${OPENCLAW_BENCHMARK_PUBLISH_RESULTS_DIR:?}"/startup-*.json)
    if [[ "${OPENCLAW_BENCHMARK_PUBLISH_RACE_KIND:-file}" == "directory" ]]; then
      mkdir -p "$destination"
    else
      printf 'competing snapshot\n' >"$destination"
    fi
    printf '%s\n' "$destination" >"${OPENCLAW_BENCHMARK_PUBLISH_RACE_MARKER:?}"
    ;;
esac
exec "${OPENCLAW_REAL_NODE:?}" "$@"
EOF
chmod +x "$benchmark_publish_race_bin/node"
write_fake_benchmark_gradlew
expect_failure_contains "Benchmark snapshot destination appeared during publication; refusing to overwrite it" \
  env \
    ANDROID_BENCHMARK_RESULTS_DIR="$benchmark_publish_results_dir" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" \
    OPENCLAW_BENCHMARK_PUBLISH_RESULTS_DIR="$benchmark_publish_results_dir" \
    OPENCLAW_BENCHMARK_PUBLISH_RACE_MARKER="$benchmark_publish_race_marker" \
    OPENCLAW_REAL_NODE="$(command -v node)" \
    PATH="$benchmark_publish_race_bin:$TMP_DIR:$PATH" \
    "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted
if [[ ! -f "$benchmark_publish_race_marker" ]]; then
  fail "benchmark publish race was not injected"
fi
benchmark_publish_race_destination="$(cat "$benchmark_publish_race_marker")"
if [[ "$(cat "$benchmark_publish_race_destination")" != "competing snapshot" ]]; then
  fail "benchmark publish race overwrote the competing snapshot: $benchmark_publish_race_destination"
fi
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

benchmark_publish_directory_results_dir="$TMP_DIR/benchmark-publish-directory-results"
benchmark_publish_directory_marker="$TMP_DIR/benchmark-publish-directory-marker"
mkdir -p "$benchmark_publish_directory_results_dir"
write_fake_benchmark_gradlew
expect_failure_contains "Benchmark snapshot destination appeared during publication; refusing to overwrite it" \
  env \
    ANDROID_BENCHMARK_RESULTS_DIR="$benchmark_publish_directory_results_dir" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" \
    OPENCLAW_BENCHMARK_PUBLISH_RESULTS_DIR="$benchmark_publish_directory_results_dir" \
    OPENCLAW_BENCHMARK_PUBLISH_RACE_MARKER="$benchmark_publish_directory_marker" \
    OPENCLAW_BENCHMARK_PUBLISH_RACE_KIND=directory \
    OPENCLAW_REAL_NODE="$(command -v node)" \
    PATH="$benchmark_publish_race_bin:$TMP_DIR:$PATH" \
    "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted
if [[ ! -f "$benchmark_publish_directory_marker" ]]; then
  fail "benchmark directory publish race was not injected"
fi
benchmark_publish_directory_destination="$(cat "$benchmark_publish_directory_marker")"
if [[ ! -d "$benchmark_publish_directory_destination" ]]; then
  fail "benchmark directory publish race did not leave the competing directory intact"
fi
if find "$benchmark_publish_directory_destination" -mindepth 1 -print -quit | grep -q .; then
  fail "benchmark directory publish race leaked the validated snapshot inside the competing directory"
fi
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

write_fake_command cp 'echo "fake cp failure" >&2; exit 77'
benchmark_snapshot_count_before="$(count_top_level_benchmark_snapshots "$ANDROID_BENCHMARK_RESULTS_DIR")"
expect_failure_contains "fake cp failure" \
  env ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" \
  "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted
benchmark_snapshot_count_after="$(count_top_level_benchmark_snapshots "$ANDROID_BENCHMARK_RESULTS_DIR")"
if [[ "$benchmark_snapshot_count_after" != "$benchmark_snapshot_count_before" ]]; then
  fail "failed benchmark snapshot copy left a selectable startup JSON"
fi
rm -f "$TMP_DIR/cp"
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

pnpm_benchmark_output="$(TMPDIR_FAKE_BASELINE="$benchmark_baseline" ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" run_with_fake_adb pnpm android:perf:startup -- --serial wanted --baseline "$benchmark_baseline" 2>&1)"
assert_contains "$pnpm_benchmark_output" "device_serial=wanted" "pnpm android:perf:startup output"
assert_contains "$pnpm_benchmark_output" "device_context=Google_Pixel_8_sdk35" "pnpm android:perf:startup output"
assert_contains "$pnpm_benchmark_output" "baseline_json=$benchmark_baseline" "pnpm android:perf:startup output"
assert_contains "$pnpm_benchmark_output" "baseline_median_ms=100 delta_ms=20.000 delta_pct=20.00%" "pnpm android:perf:startup output"
pnpm_benchmark_snapshot="$(printf '%s\n' "$pnpm_benchmark_output" | awk -F= '/^snapshot_json=/{print $2; exit}')"
if [[ -z "$pnpm_benchmark_snapshot" || ! -f "$pnpm_benchmark_snapshot" ]]; then
  fail "pnpm benchmark snapshot was not created: $pnpm_benchmark_snapshot"
fi
CLEANUP_FILES+=("$pnpm_benchmark_snapshot")
rm -f "$pnpm_benchmark_snapshot"
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

repo_relative_benchmark_baseline="$SHELL_TOOLS_BENCHMARK_OUTPUT_RELATIVE/repo-root-baseline.json"
repo_relative_benchmark_baseline_abs="$ROOT_DIR/$repo_relative_benchmark_baseline"
mkdir -p "$(dirname -- "$repo_relative_benchmark_baseline_abs")"
printf '{}\n' >"$repo_relative_benchmark_baseline_abs"
pnpm_relative_benchmark_output="$(TMPDIR_FAKE_BASELINE="$repo_relative_benchmark_baseline_abs" ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" run_with_fake_adb pnpm android:perf:startup -- --serial wanted --baseline "$repo_relative_benchmark_baseline" 2>&1)"
assert_contains "$pnpm_relative_benchmark_output" "baseline_json=$repo_relative_benchmark_baseline_abs" "pnpm repo-relative baseline output"
assert_contains "$pnpm_relative_benchmark_output" "baseline_median_ms=100 delta_ms=20.000 delta_pct=20.00%" "pnpm repo-relative baseline output"
pnpm_relative_benchmark_snapshot="$(printf '%s\n' "$pnpm_relative_benchmark_output" | awk -F= '/^snapshot_json=/{print $2; exit}')"
if [[ -z "$pnpm_relative_benchmark_snapshot" || ! -f "$pnpm_relative_benchmark_snapshot" ]]; then
  fail "pnpm repo-relative benchmark snapshot was not created: $pnpm_relative_benchmark_snapshot"
fi
CLEANUP_FILES+=("$pnpm_relative_benchmark_snapshot")
rm -f "$pnpm_relative_benchmark_snapshot"
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

write_fake_adb 'if [[ "${1-}" == "devices" ]]; then
  printf "List of devices attached\n"
  printf "wanted\tdevice\n"
  printf "other\tdevice\n"
  exit 0
fi
echo "unexpected adb args: $*" >&2
exit 64'
benchmark_env_serial_output="$(ANDROID_SERIAL=wanted ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" 2>&1)"
assert_contains "$benchmark_env_serial_output" "device_serial=wanted" "ANDROID_SERIAL benchmark output"
benchmark_env_serial_snapshot="$(printf '%s\n' "$benchmark_env_serial_output" | awk -F= '/^snapshot_json=/{print $2; exit}')"
if [[ -z "$benchmark_env_serial_snapshot" || ! -f "$benchmark_env_serial_snapshot" ]]; then
  fail "ANDROID_SERIAL benchmark snapshot was not created: $benchmark_env_serial_snapshot"
fi
CLEANUP_FILES+=("$benchmark_env_serial_snapshot")
rm -f "$benchmark_env_serial_snapshot"
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

relative_results_root="$TMP_DIR/relative-results-root"
mkdir -p "$relative_results_root"
relative_results_output="$(
  cd "$relative_results_root"
  ANDROID_BENCHMARK_RESULTS_DIR=relative-benchmark-results \
    ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted 2>&1
)"
relative_results_snapshot="$(printf '%s\n' "$relative_results_output" | awk -F= '/^snapshot_json=/{print $2; exit}')"
assert_contains "$relative_results_snapshot" "$relative_results_root/relative-benchmark-results/startup-" "relative results snapshot path"
if [[ -z "$relative_results_snapshot" || ! -f "$relative_results_snapshot" ]]; then
  fail "relative ANDROID_BENCHMARK_RESULTS_DIR snapshot was not created: $relative_results_snapshot"
fi
CLEANUP_FILES+=("$relative_results_snapshot")
rm -f "$relative_results_snapshot"
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

symlink_results_target="$TMP_DIR/symlink-benchmark-results-target"
symlink_results_dir="$TMP_DIR/symlink-benchmark-results"
mkdir -p "$symlink_results_target"
ln -s "$symlink_results_target" "$symlink_results_dir"
symlink_results_baseline="$symlink_results_dir/startup-compatible-symlink-shell-tools-test.json"
printf '{}\n' >"$symlink_results_baseline"
touch -t 202401010101 "$symlink_results_baseline"
symlink_results_output="$(
  ANDROID_BENCHMARK_RESULTS_DIR="$symlink_results_dir" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted 2>&1
)"
assert_contains "$symlink_results_output" "baseline_json=$symlink_results_baseline" "symlink results baseline output"
assert_contains "$symlink_results_output" "baseline_median_ms=90 delta_ms=30.000 delta_pct=33.33%" "symlink results baseline output"
symlink_results_snapshot="$(printf '%s\n' "$symlink_results_output" | awk -F= '/^snapshot_json=/{print $2; exit}')"
if [[ -z "$symlink_results_snapshot" || ! -f "$symlink_results_snapshot" ]]; then
  fail "symlink results snapshot was not created: $symlink_results_snapshot"
fi
rm -f "$symlink_results_snapshot" "$symlink_results_baseline"
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

benchmark_results_dir="$ANDROID_BENCHMARK_RESULTS_DIR"
mkdir -p "$benchmark_results_dir"
benchmark_preexisting_baseline="$benchmark_results_dir/startup-compatible-preexisting-shell-tools-test.json"
benchmark_concurrent_baseline="$benchmark_results_dir/startup-compatible-concurrent-shell-tools-test.json"
printf '{}\n' >"$benchmark_preexisting_baseline"
touch -t 202401010101 "$benchmark_preexisting_baseline"
benchmark_concurrent_output="$(
  OPENCLAW_FAKE_CREATE_AUTO_BASELINE="$benchmark_concurrent_baseline" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted 2>&1
)"
assert_contains "$benchmark_concurrent_output" "baseline_json=$benchmark_preexisting_baseline" "concurrent auto baseline output"
assert_not_contains "$benchmark_concurrent_output" "baseline_json=$benchmark_concurrent_baseline" "concurrent auto baseline output"
benchmark_concurrent_snapshot="$(printf '%s\n' "$benchmark_concurrent_output" | awk -F= '/^snapshot_json=/{print $2; exit}')"
CLEANUP_FILES+=("$benchmark_preexisting_baseline" "$benchmark_concurrent_baseline" "$benchmark_concurrent_snapshot")
rm -f "$benchmark_preexisting_baseline" "$benchmark_concurrent_baseline" "$benchmark_concurrent_snapshot"
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

benchmark_torn_auto_baseline="$benchmark_results_dir/startup-compatible-torn-copy-shell-tools-test.json"
benchmark_torn_auto_gradle_marker="$TMP_DIR/torn-auto-baseline-gradle-called"
printf '{}\n' >"$benchmark_torn_auto_baseline"
real_cp="$(command -v cp)"
write_fake_command cp '
source_path="${1-}"
destination_path="${2-}"
if [[ "$source_path" == "--" ]]; then
  source_path="${2-}"
  destination_path="${3-}"
fi
"$OPENCLAW_REAL_CP" -- "$source_path" "$destination_path"
if [[ "$source_path" == "$OPENCLAW_FAKE_TORN_AUTO_BASELINE" ]]; then
  printf "{\"openclawFakeTornCopy\":true}\n" >"$destination_path"
fi'
write_fake_command gradlew-torn-auto-baseline '
printf "called\n" >"$OPENCLAW_FAKE_GRADLE_MARKER"
exec "$OPENCLAW_FAKE_BENCHMARK_GRADLEW" "$@"'
expect_failure_contains "Stable local benchmark snapshot copy does not match source" \
  env \
    OPENCLAW_REAL_CP="$real_cp" \
    OPENCLAW_FAKE_TORN_AUTO_BASELINE="$benchmark_torn_auto_baseline" \
    OPENCLAW_FAKE_GRADLE_MARKER="$benchmark_torn_auto_gradle_marker" \
    OPENCLAW_FAKE_BENCHMARK_GRADLEW="$TMP_DIR/gradlew-benchmark" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew-torn-auto-baseline" \
    "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted
if [[ -e "$benchmark_torn_auto_gradle_marker" ]]; then
  fail "benchmark ran Gradle after copying a torn implicit baseline"
fi
rm -f "$TMP_DIR/cp" "$TMP_DIR/gradlew-torn-auto-baseline" "$benchmark_torn_auto_baseline"
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

benchmark_subsecond_older="$benchmark_results_dir/startup-compatible-z-subsecond-shell-tools-test.json"
benchmark_subsecond_newer="$benchmark_results_dir/startup-compatible-a-subsecond-shell-tools-test.json"
printf '{}\n' >"$benchmark_subsecond_older"
printf '{}\n' >"$benchmark_subsecond_newer"
node - "$benchmark_subsecond_older" "$benchmark_subsecond_newer" <<'EOF'
const fs = require("node:fs");

const [older, newer] = process.argv.slice(2);
const second = Date.UTC(2025, 0, 1, 1, 1, 0);
fs.utimesSync(older, new Date(second + 100), new Date(second + 100));
fs.utimesSync(newer, new Date(second + 900), new Date(second + 900));
EOF
benchmark_subsecond_output="$(
  ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted 2>&1
)"
assert_contains "$benchmark_subsecond_output" "baseline_json=$benchmark_subsecond_newer" "subsecond auto baseline output"
assert_not_contains "$benchmark_subsecond_output" "baseline_json=$benchmark_subsecond_older" "subsecond auto baseline output"
benchmark_subsecond_snapshot="$(printf '%s\n' "$benchmark_subsecond_output" | awk -F= '/^snapshot_json=/{print $2; exit}')"
CLEANUP_FILES+=("$benchmark_subsecond_older" "$benchmark_subsecond_newer" "$benchmark_subsecond_snapshot")
rm -f "$benchmark_subsecond_older" "$benchmark_subsecond_newer" "$benchmark_subsecond_snapshot"
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

benchmark_dst_older="$benchmark_results_dir/startup-compatible-z-dst-shell-tools-test.json"
benchmark_dst_newer="$benchmark_results_dir/startup-compatible-a-dst-shell-tools-test.json"
printf '{}\n' >"$benchmark_dst_older"
printf '{}\n' >"$benchmark_dst_newer"
node - "$benchmark_dst_older" "$benchmark_dst_newer" <<'EOF'
const fs = require("node:fs");

const [older, newer] = process.argv.slice(2);
fs.utimesSync(older, new Date("2025-11-02T08:30:00.100Z"), new Date("2025-11-02T08:30:00.100Z"));
fs.utimesSync(newer, new Date("2025-11-02T09:15:00.900Z"), new Date("2025-11-02T09:15:00.900Z"));
EOF
benchmark_dst_output="$(
  TZ=America/Los_Angeles \
    ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted 2>&1
)"
assert_contains "$benchmark_dst_output" "baseline_json=$benchmark_dst_newer" "DST fallback auto baseline output"
assert_not_contains "$benchmark_dst_output" "baseline_json=$benchmark_dst_older" "DST fallback auto baseline output"
benchmark_dst_snapshot="$(printf '%s\n' "$benchmark_dst_output" | awk -F= '/^snapshot_json=/{print $2; exit}')"
CLEANUP_FILES+=("$benchmark_dst_older" "$benchmark_dst_newer" "$benchmark_dst_snapshot")
rm -f "$benchmark_dst_older" "$benchmark_dst_newer" "$benchmark_dst_snapshot"
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

benchmark_compatible="$benchmark_results_dir/startup-compatible-shell-tools-test.json"
benchmark_missing_context="$benchmark_results_dir/startup-compatible-missing-context-shell-tools-test.json"
  benchmark_missing_median="$benchmark_results_dir/startup-compatible-missing-median-shell-tools-test.json"
  benchmark_duplicate_median="$benchmark_results_dir/startup-compatible-duplicate-median-shell-tools-test.json"
  benchmark_zero_median="$benchmark_results_dir/startup-compatible-zero-median-shell-tools-test.json"
  benchmark_invalid_runs="$benchmark_results_dir/startup-compatible-invalid-runs-shell-tools-test.json"
  benchmark_incompatible="$benchmark_results_dir/startup-incompatible-shell-tools-test.json"
  benchmark_incompatible_fingerprint="$benchmark_results_dir/startup-incompatible-fingerprint-shell-tools-test.json"
  CLEANUP_FILES+=("$benchmark_compatible" "$benchmark_missing_context" "$benchmark_missing_median" "$benchmark_duplicate_median" "$benchmark_zero_median" "$benchmark_invalid_runs" "$benchmark_incompatible" "$benchmark_incompatible_fingerprint")
  printf '{}\n' >"$benchmark_compatible"
  printf '{}\n' >"$benchmark_missing_context"
  printf '{}\n' >"$benchmark_missing_median"
  printf '{}\n' >"$benchmark_duplicate_median"
  printf '{}\n' >"$benchmark_zero_median"
  printf '{}\n' >"$benchmark_invalid_runs"
  printf '{}\n' >"$benchmark_incompatible"
  printf '{}\n' >"$benchmark_incompatible_fingerprint"
  touch -t 202401010101 "$benchmark_compatible"
  touch -t 202501010101 "$benchmark_missing_median"
  touch -t 202601010101 "$benchmark_duplicate_median"
  touch -t 202701010101 "$benchmark_missing_context"
  touch -t 202801010101 "$benchmark_zero_median"
  touch -t 202901010101 "$benchmark_incompatible_fingerprint"
  touch -t 203001010101 "$benchmark_invalid_runs"
if ! benchmark_auto_output="$(ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted 2>&1)"; then
  fail "auto baseline selection did not skip a compatible snapshot with malformed raw runs: $benchmark_auto_output"
fi
assert_contains "$benchmark_auto_output" "baseline_json=$benchmark_compatible" "auto baseline output"
assert_not_contains "$benchmark_auto_output" "baseline_json=$benchmark_invalid_runs" "auto baseline output"
assert_contains "$benchmark_auto_output" "baseline_median_ms=90 delta_ms=30.000 delta_pct=33.33%" "auto baseline output"
benchmark_auto_snapshot="$(printf '%s\n' "$benchmark_auto_output" | awk -F= '/^snapshot_json=/{print $2; exit}')"
CLEANUP_FILES+=("$benchmark_auto_snapshot")
  rm -f "$benchmark_auto_snapshot" "$benchmark_compatible" "$benchmark_missing_context" "$benchmark_missing_median" "$benchmark_duplicate_median" "$benchmark_zero_median" "$benchmark_invalid_runs" "$benchmark_incompatible" "$benchmark_incompatible_fingerprint"
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

benchmark_newline_baseline="$benchmark_results_dir/startup-compatible-newline"$'\n'"shell-tools-test.json"
CLEANUP_FILES+=("$benchmark_newline_baseline")
printf '{}\n' >"$benchmark_newline_baseline"
touch -t 202501010101 "$benchmark_newline_baseline"
benchmark_newline_output="$(
  ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted 2>&1
)"
assert_contains "$benchmark_newline_output" "baseline_json=$benchmark_newline_baseline" "newline-path auto baseline output"
assert_contains "$benchmark_newline_output" "baseline_median_ms=90 delta_ms=30.000 delta_pct=33.33%" "newline-path auto baseline output"
benchmark_newline_snapshot="$(printf '%s\n' "$benchmark_newline_output" | awk -F= '/^snapshot_json=/{print $2; exit}')"
CLEANUP_FILES+=("$benchmark_newline_snapshot")
rm -f "$benchmark_newline_snapshot" "$benchmark_newline_baseline"
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

benchmark_incompatible_only="$benchmark_results_dir/startup-incompatible-only-shell-tools-test.json"
CLEANUP_FILES+=("$benchmark_incompatible_only")
printf '{}\n' >"$benchmark_incompatible_only"
touch -t 202501010101 "$benchmark_incompatible_only"
benchmark_no_compatible_output="$(ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted)"
assert_contains "$benchmark_no_compatible_output" "baseline_median_ms=skipped reason=no-compatible-local-snapshot device_context=Google_Pixel_8_sdk35" "no compatible baseline output"
benchmark_no_compatible_snapshot="$(printf '%s\n' "$benchmark_no_compatible_output" | awk -F= '/^snapshot_json=/{print $2; exit}')"
CLEANUP_FILES+=("$benchmark_no_compatible_snapshot")
rm -f "$benchmark_no_compatible_snapshot" "$benchmark_incompatible_only"
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

benchmark_invalid_explicit_baseline="$benchmark_results_dir/startup-compatible-missing-median-explicit-baseline.json"
CLEANUP_FILES+=("$benchmark_invalid_explicit_baseline")
printf '{}\n' >"$benchmark_invalid_explicit_baseline"
benchmark_snapshot_count_before="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
expect_failure_contains "Missing or invalid numeric baseline coldStartup median" \
  env ANDROID_GRADLEW="$TMP_DIR/missing-gradlew" \
  "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --baseline "$benchmark_invalid_explicit_baseline"
benchmark_snapshot_count_after="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
if [[ "$benchmark_snapshot_count_after" != "$benchmark_snapshot_count_before" ]]; then
  fail "invalid explicit baseline run wrote a timestamped snapshot"
fi
  rm -f "$benchmark_invalid_explicit_baseline"
  rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

  benchmark_zero_explicit_baseline="$benchmark_results_dir/startup-zero-median-explicit-baseline.json"
  CLEANUP_FILES+=("$benchmark_zero_explicit_baseline")
  printf '{}\n' >"$benchmark_zero_explicit_baseline"
  benchmark_snapshot_count_before="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
  expect_failure_contains "Missing or invalid numeric baseline coldStartup median" \
    env ANDROID_GRADLEW="$TMP_DIR/missing-gradlew" \
    "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --baseline "$benchmark_zero_explicit_baseline"
  benchmark_snapshot_count_after="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
  if [[ "$benchmark_snapshot_count_after" != "$benchmark_snapshot_count_before" ]]; then
    fail "zero-median explicit baseline run wrote a timestamped snapshot"
  fi
  rm -f "$benchmark_zero_explicit_baseline"

  benchmark_inconsistent_explicit_baseline="$benchmark_results_dir/startup-inconsistent-explicit-baseline.json"
  CLEANUP_FILES+=("$benchmark_inconsistent_explicit_baseline")
  printf '{}\n' >"$benchmark_inconsistent_explicit_baseline"
  benchmark_snapshot_count_before="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
  expect_failure_contains "Inconsistent baseline coldStartup summary: reported median does not match runs" \
    env OPENCLAW_FAKE_INCONSISTENT_RUN_MEDIAN=1 ANDROID_GRADLEW="$TMP_DIR/missing-gradlew" \
    "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted --baseline "$benchmark_inconsistent_explicit_baseline"
  benchmark_snapshot_count_after="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
  if [[ "$benchmark_snapshot_count_after" != "$benchmark_snapshot_count_before" ]]; then
    fail "inconsistent explicit baseline run wrote a timestamped snapshot"
  fi
  rm -f "$benchmark_inconsistent_explicit_baseline"

write_fake_bad_benchmark_gradlew
benchmark_snapshot_count_before="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
expect_failure_contains "Missing or invalid numeric coldStartup median" \
  env ANDROID_GRADLEW="$TMP_DIR/gradlew-bad-benchmark" \
  "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted
benchmark_snapshot_count_after="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
if [[ "$benchmark_snapshot_count_after" != "$benchmark_snapshot_count_before" ]]; then
  fail "malformed benchmark run wrote a timestamped snapshot"
fi
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

write_fake_string_benchmark_gradlew
benchmark_snapshot_count_before="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
expect_failure_contains "Missing or invalid numeric coldStartup median" \
  env ANDROID_GRADLEW="$TMP_DIR/gradlew-string-benchmark" \
  "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted
benchmark_snapshot_count_after="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
if [[ "$benchmark_snapshot_count_after" != "$benchmark_snapshot_count_before" ]]; then
  fail "string-valued benchmark run wrote a timestamped snapshot"
fi
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

write_fake_missing_runs_benchmark_gradlew
benchmark_snapshot_count_before="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
expect_failure_contains "Missing or invalid numeric coldStartup run count" \
  env ANDROID_GRADLEW="$TMP_DIR/gradlew-missing-runs-benchmark" \
  "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted
benchmark_snapshot_count_after="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
if [[ "$benchmark_snapshot_count_after" != "$benchmark_snapshot_count_before" ]]; then
  fail "missing-runs benchmark run wrote a timestamped snapshot"
fi
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

write_fake_invalid_runs_benchmark_gradlew
benchmark_snapshot_count_before="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
expect_failure_contains "Missing or invalid numeric coldStartup run count" \
  env ANDROID_GRADLEW="$TMP_DIR/gradlew-invalid-runs-benchmark" \
  "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted
benchmark_snapshot_count_after="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
if [[ "$benchmark_snapshot_count_after" != "$benchmark_snapshot_count_before" ]]; then
  fail "invalid-runs benchmark run wrote a timestamped snapshot"
fi
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

write_fake_benchmark_gradlew
benchmark_snapshot_count_before="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
expect_failure_contains "Unexpected coldStartup run count: expected 10, got 9" \
  env OPENCLAW_FAKE_RUN_COUNT=9 ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" \
  "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted
benchmark_snapshot_count_after="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
if [[ "$benchmark_snapshot_count_after" != "$benchmark_snapshot_count_before" ]]; then
  fail "partial benchmark run wrote a timestamped snapshot"
fi
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

write_fake_benchmark_gradlew
benchmark_snapshot_count_before="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
expect_failure_contains "Inconsistent coldStartup summary: expected minimum <= median <= maximum" \
  env OPENCLAW_FAKE_INCONSISTENT_STATS=1 ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" \
  "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted
benchmark_snapshot_count_after="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
if [[ "$benchmark_snapshot_count_after" != "$benchmark_snapshot_count_before" ]]; then
  fail "inconsistent-stat benchmark run wrote a timestamped snapshot"
fi
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

write_fake_benchmark_gradlew
benchmark_snapshot_count_before="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
expect_failure_contains "Inconsistent coldStartup summary: reported minimum/maximum do not match runs" \
  env OPENCLAW_FAKE_INCONSISTENT_RUN_BOUNDS=1 ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" \
  "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted
benchmark_snapshot_count_after="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
if [[ "$benchmark_snapshot_count_after" != "$benchmark_snapshot_count_before" ]]; then
  fail "run-bound-inconsistent benchmark run wrote a timestamped snapshot"
fi
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

write_fake_benchmark_gradlew
benchmark_snapshot_count_before="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
expect_failure_contains "Inconsistent coldStartup summary: reported median does not match runs" \
  env OPENCLAW_FAKE_INCONSISTENT_RUN_MEDIAN=1 ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" \
  "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted
benchmark_snapshot_count_after="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
if [[ "$benchmark_snapshot_count_after" != "$benchmark_snapshot_count_before" ]]; then
  fail "run-median-inconsistent benchmark run wrote a timestamped snapshot"
fi
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

write_fake_benchmark_gradlew
benchmark_snapshot_count_before="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
expect_failure_contains "Inconsistent coldStartup summary: reported coefficientOfVariation does not match runs" \
  env OPENCLAW_FAKE_REPORTED_COV=0.30 ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" \
  "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted
benchmark_snapshot_count_after="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
if [[ "$benchmark_snapshot_count_after" != "$benchmark_snapshot_count_before" ]]; then
  fail "run-COV-inconsistent benchmark run wrote a timestamped snapshot"
fi
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

write_fake_benchmark_gradlew
benchmark_snapshot_count_before="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
expect_failure_contains "Missing or invalid non-negative numeric coldStartup coefficientOfVariation" \
  env OPENCLAW_FAKE_INVALID_REPORTED_COV=1 ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" \
  "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted
benchmark_snapshot_count_after="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
if [[ "$benchmark_snapshot_count_after" != "$benchmark_snapshot_count_before" ]]; then
  fail "invalid-COV benchmark run wrote a timestamped snapshot"
fi
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

write_fake_bad_device_context_benchmark_gradlew
benchmark_snapshot_count_before="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
expect_failure_contains "Missing or invalid non-empty string device brand" \
  env ANDROID_GRADLEW="$TMP_DIR/gradlew-bad-device-context-benchmark" \
  "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted
benchmark_snapshot_count_after="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
if [[ "$benchmark_snapshot_count_after" != "$benchmark_snapshot_count_before" ]]; then
  fail "bad-device-context benchmark run wrote a timestamped snapshot"
fi
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

write_fake_bad_device_context_benchmark_gradlew
benchmark_snapshot_count_before="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
expect_failure_contains "Missing or invalid non-empty string device fingerprint" \
  env OPENCLAW_FAKE_MISSING_FINGERPRINT=1 \
  ANDROID_GRADLEW="$TMP_DIR/gradlew-bad-device-context-benchmark" \
  "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted
benchmark_snapshot_count_after="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
if [[ "$benchmark_snapshot_count_after" != "$benchmark_snapshot_count_before" ]]; then
  fail "missing-fingerprint benchmark run wrote a timestamped snapshot"
fi
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

write_fake_bad_device_context_benchmark_gradlew
benchmark_snapshot_count_before="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
expect_failure_contains "Missing or invalid positive integer device sdk version" \
  env OPENCLAW_FAKE_INVALID_SDK=1 \
  ANDROID_GRADLEW="$TMP_DIR/gradlew-bad-device-context-benchmark" \
  "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted
benchmark_snapshot_count_after="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
if [[ "$benchmark_snapshot_count_after" != "$benchmark_snapshot_count_before" ]]; then
  fail "invalid-sdk benchmark run wrote a timestamped snapshot"
fi
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

write_fake_duplicate_benchmark_gradlew
benchmark_snapshot_count_before="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
expect_failure_contains "Missing or invalid numeric coldStartup benchmark entry count" \
  env ANDROID_GRADLEW="$TMP_DIR/gradlew-duplicate-benchmark" \
  "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted
benchmark_snapshot_count_after="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
if [[ "$benchmark_snapshot_count_after" != "$benchmark_snapshot_count_before" ]]; then
  fail "duplicate-metric benchmark run wrote a timestamped snapshot"
fi
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

benchmark_snapshot_count_before="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
expect_failure_contains "Missing or invalid numeric coldStartup benchmark entry count" \
  env OPENCLAW_FAKE_PARTIAL_DUPLICATE_BENCHMARK=1 ANDROID_GRADLEW="$TMP_DIR/gradlew-duplicate-benchmark" \
  "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted
benchmark_snapshot_count_after="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
if [[ "$benchmark_snapshot_count_after" != "$benchmark_snapshot_count_before" ]]; then
  fail "partially duplicate benchmark run wrote a timestamped snapshot"
fi
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

write_fake_stale_benchmark_gradlew
stale_output_dir="$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR/stale"
tabbed_stale_output_dir="$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR/stale"$'\t'"output"
mkdir -p "$stale_output_dir" "$tabbed_stale_output_dir"
printf '{}\n' >"$stale_output_dir/stale-benchmarkData.json"
printf '{}\n' >"$tabbed_stale_output_dir/stale-benchmarkData.json"
touch -t 202401010101 "$stale_output_dir/stale-benchmarkData.json"
touch -t 202401010101 "$tabbed_stale_output_dir/stale-benchmarkData.json"
expect_failure_contains "No new benchmarkData.json was produced by this run" \
  env ANDROID_GRADLEW="$TMP_DIR/gradlew-stale-benchmark" \
  "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

write_fake_multiple_outputs_benchmark_gradlew
benchmark_snapshot_count_before="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
expect_failure_contains "Expected exactly one new benchmarkData.json from this run, found 2" \
  env ANDROID_GRADLEW="$TMP_DIR/gradlew-multiple-outputs-benchmark" \
  "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted
benchmark_snapshot_count_after="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
if [[ "$benchmark_snapshot_count_after" != "$benchmark_snapshot_count_before" ]]; then
  fail "ambiguous multiple-output benchmark run wrote a timestamped snapshot"
fi
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

real_find="$(command -v find)"
write_fake_command find '
if [[ -f "${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:?}/current/current-benchmarkData.json" ]]; then
  "$OPENCLAW_REAL_FIND" "$@"
  exit 73
fi
exec "$OPENCLAW_REAL_FIND" "$@"
'
write_fake_benchmark_gradlew
benchmark_snapshot_count_before="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
expect_failure_contains "Failed to scan benchmark outputs after the macrobenchmark run" \
  env OPENCLAW_REAL_FIND="$real_find" ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" PATH="$TMP_DIR:$PATH" \
  "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted
benchmark_snapshot_count_after="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
if [[ "$benchmark_snapshot_count_after" != "$benchmark_snapshot_count_before" ]]; then
  fail "partial benchmark output scan wrote a timestamped snapshot"
fi
rm -f "$TMP_DIR/find"
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

real_stat="$(command -v stat)"
write_fake_command stat '
for arg in "$@"; do
  case "$arg" in
    *current-benchmarkData.json)
      echo "simulated benchmark output stat failure" >&2
      exit 73
      ;;
  esac
done
exec "$OPENCLAW_REAL_STAT" "$@"
'
write_fake_benchmark_gradlew
benchmark_snapshot_count_before="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
expect_failure_contains "Failed to inspect benchmark output produced by this run" \
  env OPENCLAW_REAL_STAT="$real_stat" ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" PATH="$TMP_DIR:$PATH" \
  "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted
benchmark_snapshot_count_after="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
if [[ "$benchmark_snapshot_count_after" != "$benchmark_snapshot_count_before" ]]; then
  fail "benchmark output stat failure wrote a timestamped snapshot"
fi
rm -f "$TMP_DIR/stat"
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

write_fake_command cksum '
echo "simulated benchmark output checksum failure" >&2
exit 74
'
write_fake_benchmark_gradlew
benchmark_snapshot_count_before="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
expect_failure_contains "Failed to inspect benchmark output produced by this run" \
  env ANDROID_GRADLEW="$TMP_DIR/gradlew-benchmark" PATH="$TMP_DIR:$PATH" \
  "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted
benchmark_snapshot_count_after="$(count_top_level_benchmark_snapshots "$benchmark_results_dir")"
if [[ "$benchmark_snapshot_count_after" != "$benchmark_snapshot_count_before" ]]; then
  fail "benchmark output checksum failure wrote a timestamped snapshot"
fi
rm -f "$TMP_DIR/cksum"
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

benchmark_torn_state_outputs_dir="$TMP_DIR/benchmark-torn-state-outputs"
benchmark_torn_state_results_dir="$TMP_DIR/benchmark-torn-state-results"
benchmark_torn_state_json="$benchmark_torn_state_outputs_dir/stale/stale-benchmarkData.json"
benchmark_torn_state_marker="$TMP_DIR/benchmark-torn-state-mutated"
mkdir -p "$(dirname -- "$benchmark_torn_state_json")" "$benchmark_torn_state_results_dir"
printf '{"openclawFakeStaleOutput":true}\n' >"$benchmark_torn_state_json"
real_cksum="$(command -v cksum)"
write_fake_command cksum '
checksum="$("$OPENCLAW_REAL_CKSUM")"
if [[ ! -e "$OPENCLAW_FAKE_CKSUM_MUTATION_MARKER" ]]; then
  printf "{}\n" >"$OPENCLAW_FAKE_CKSUM_MUTATION_TARGET"
  printf "mutated\n" >"$OPENCLAW_FAKE_CKSUM_MUTATION_MARKER"
fi
printf "%s\n" "$checksum"'
write_fake_stale_benchmark_gradlew
expect_failure_contains "File changed while its state was being inspected" \
  env \
    OPENCLAW_REAL_CKSUM="$real_cksum" \
    OPENCLAW_FAKE_CKSUM_MUTATION_TARGET="$benchmark_torn_state_json" \
    OPENCLAW_FAKE_CKSUM_MUTATION_MARKER="$benchmark_torn_state_marker" \
    ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR="$benchmark_torn_state_outputs_dir" \
    ANDROID_BENCHMARK_RESULTS_DIR="$benchmark_torn_state_results_dir" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew-stale-benchmark" \
    "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted
if [[ ! -e "$benchmark_torn_state_marker" ]]; then
  fail "benchmark output mutation was not injected during state inspection"
fi
if [[ "$(count_top_level_benchmark_snapshots "$benchmark_torn_state_results_dir")" != "0" ]]; then
  fail "benchmark accepted an artifact that changed during pre-run state inspection"
fi
rm -f "$TMP_DIR/cksum"

write_fake_same_mtime_benchmark_gradlew
same_mtime_output_dir="$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR/same-mtime"
mkdir -p "$same_mtime_output_dir"
printf '{"openclawFakeStaleSameMtimeOutput":true}\n' >"$same_mtime_output_dir/current-benchmarkData.json"
touch -t 202401010101 "$same_mtime_output_dir/current-benchmarkData.json"
same_mtime_output="$(ANDROID_GRADLEW="$TMP_DIR/gradlew-same-mtime-benchmark" run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted)"
assert_contains "$same_mtime_output" "startup.cold.median_ms=120.000" "same-mtime benchmark output"
same_mtime_snapshot="$(printf '%s\n' "$same_mtime_output" | awk -F= '/^snapshot_json=/{print $2; exit}')"
if [[ -z "$same_mtime_snapshot" || ! -f "$same_mtime_snapshot" ]]; then
  fail "same-mtime benchmark snapshot was not created: $same_mtime_snapshot"
fi
CLEANUP_FILES+=("$same_mtime_snapshot")
rm -f "$same_mtime_snapshot"
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

write_fake_identical_benchmark_gradlew
identical_output_dir="$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR/identical"
mkdir -p "$identical_output_dir"
printf '{}\n' >"$identical_output_dir/current-benchmarkData.json"
touch -t 202401010101 "$identical_output_dir/current-benchmarkData.json"
identical_output="$(ANDROID_GRADLEW="$TMP_DIR/gradlew-identical-benchmark" run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted)"
assert_contains "$identical_output" "startup.cold.median_ms=120.000" "identical benchmark output"
identical_snapshot="$(printf '%s\n' "$identical_output" | awk -F= '/^snapshot_json=/{print $2; exit}')"
if [[ -z "$identical_snapshot" || ! -f "$identical_snapshot" ]]; then
  fail "identical benchmark snapshot was not created: $identical_snapshot"
fi
CLEANUP_FILES+=("$identical_snapshot")
rm -f "$identical_snapshot"
rm -rf "$SHELL_TOOLS_BENCHMARK_OUTPUT_DIR"

write_fake_adb 'if [[ "${1-}" == "devices" ]]; then
  printf "List of devices attached\n"
  printf "wanted\tdevice\n"
  exit 0
fi
if [[ "${1-}" == "-s" && "${2-}" == "wanted" && "${3-}" == "shell" && "${4-}" == "am" && "${5-}" == "start" ]]; then
  printf "Starting: Intent { cmp=%s }\n" "${7-}"
  exit 0
fi
echo "unexpected adb args: $*" >&2
exit 64'
env_launch_output="$(ANDROID_SERIAL=wanted run_with_fake_adb "$ANDROID_DIR/scripts/run-debug.sh" --no-install)"
assert_contains "$env_launch_output" "device_serial=wanted" "ANDROID_SERIAL launch output"
assert_contains "$env_launch_output" "component=ai.openclaw.android/.MainActivity" "ANDROID_SERIAL launch output"

no_sdk_launch_output="$(
  env -u ANDROID_HOME -u ANDROID_SDK_ROOT \
    HOME="$TMP_DIR/no-home" \
    ANDROID_GRADLEW="$TMP_DIR/missing-gradlew" \
    PATH="$TMP_DIR:$PATH" \
    "$ANDROID_DIR/scripts/run-debug.sh" \
      --no-install \
      --serial wanted
)"
assert_contains "$no_sdk_launch_output" "device_serial=wanted" "no-SDK no-install launch output"
assert_contains "$no_sdk_launch_output" "component=ai.openclaw.android/.MainActivity" "no-SDK no-install launch output"

pnpm_launch_output="$(run_with_fake_adb pnpm android:run -- --no-install --serial wanted)"
assert_contains "$pnpm_launch_output" "device_serial=wanted" "pnpm android:run output"
assert_contains "$pnpm_launch_output" "component=ai.openclaw.android/.MainActivity" "pnpm android:run output"

pnpm_custom_task_launch_output="$(ANDROID_GRADLEW="$TMP_DIR/gradlew" run_with_fake_adb pnpm android:run -- --serial wanted --package ai.openclaw.custom --activity .CustomActivity --task :benchmark:installDebug)"
assert_contains "$pnpm_custom_task_launch_output" "fake_gradlew_args=:benchmark:installDebug -Pandroid.injected.device.serial=wanted --console=plain" "pnpm android:run custom task output"
assert_contains "$pnpm_custom_task_launch_output" "component=ai.openclaw.custom/.CustomActivity" "pnpm android:run custom task output"

expect_failure_contains "Missing value for --serial" "$ANDROID_DIR/scripts/run-debug.sh" --serial
expect_failure_contains "Missing value for --serial" "$ANDROID_DIR/scripts/install-debug.sh" --serial
expect_failure_contains "Missing value for --serial" pnpm android:install -- --serial
expect_failure_contains "Unexpected positional args" "$ANDROID_DIR/scripts/run-debug.sh" --no-install -- extra
expect_failure_contains "Missing value for --task" "$ANDROID_DIR/scripts/run-debug.sh" --task
expect_failure_contains "Missing value for --task" "$ANDROID_DIR/scripts/install-debug.sh" --task
expect_failure_contains "Missing value for --task" pnpm android:install -- --task
expect_failure_contains "Invalid Gradle task path" "$ANDROID_DIR/scripts/install-debug.sh" --task 'app install'
expect_failure_contains "Invalid Gradle task path" "$ANDROID_DIR/scripts/run-debug.sh" --task 'app;installDebug'
expect_failure_contains "Invalid Gradle task path" pnpm android:install -- --task 'app install'
expect_failure_contains "Gradle task must be an install task path" "$ANDROID_DIR/scripts/install-debug.sh" --task :app:assembleDebug
expect_failure_contains "Gradle task must be an install task path" "$ANDROID_DIR/scripts/run-debug.sh" --task :app:assembleDebug
expect_failure_contains "Gradle task must be an install task path" pnpm android:install -- --task :app:assembleDebug
expect_failure_contains "Baseline file missing" "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --baseline "$TMP_DIR/missing.json"
expect_failure_contains "Missing value for --baseline" "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --baseline
expect_failure_contains "Missing value for --serial" "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial
benchmark_results_file="$TMP_DIR/not-a-benchmark-results-dir"
printf 'not a directory\n' >"$benchmark_results_file"
expect_failure_contains "ANDROID_BENCHMARK_RESULTS_DIR must be a directory path" \
  env ANDROID_BENCHMARK_RESULTS_DIR="$benchmark_results_file" \
  "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted
benchmark_build_outputs_file="$TMP_DIR/not-a-benchmark-build-outputs-dir"
printf 'not a directory\n' >"$benchmark_build_outputs_file"
expect_failure_contains "ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR must be a directory path" \
  env ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR="$benchmark_build_outputs_file" \
  "$ANDROID_DIR/scripts/perf-startup-benchmark.sh" --serial wanted
expect_failure_contains "Missing value for --package" "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --package
expect_failure_contains "Missing value for --activity" "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --activity
expect_failure_contains "Missing value for --arch" "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --arch
expect_failure_contains "--arch must be one of arm, arm64, x86, or x86_64" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --arch mips
expect_failure_contains "Missing value for --duration" "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --duration
expect_failure_contains "--duration must be a positive integer" "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --duration 0
expect_failure_contains "Missing value for --serial" "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial
expect_failure_contains "Missing value for --out" "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --out
hotspots_out_dir="$TMP_DIR/hotspots-out-dir"
mkdir -p "$hotspots_out_dir"
expect_failure_contains "--out must be a file path" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --out "$hotspots_out_dir"
expect_failure_contains "--out must be a file path" \
  env PATH="/usr/bin:/bin" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --out "$hotspots_out_dir"
hotspots_out_symlink_target="$TMP_DIR/hotspots-out-symlink-target"
hotspots_out_symlink="$TMP_DIR/hotspots-out-symlink"
printf 'do not replace\n' >"$hotspots_out_symlink_target"
ln -s "$hotspots_out_symlink_target" "$hotspots_out_symlink"
expect_failure_contains "--out must be a regular file path; symlinks are rejected" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --out "$hotspots_out_symlink"
if [[ "$(cat "$hotspots_out_symlink_target")" != "do not replace" ]]; then
  fail "hotspots symlink rejection modified its target"
fi
hotspots_out_fifo="$TMP_DIR/hotspots-out-fifo"
mkfifo "$hotspots_out_fifo"
expect_failure_contains "--out must be a regular file path; special files are rejected" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --out "$hotspots_out_fifo"
hotspots_out_parent_file="$TMP_DIR/hotspots-out-parent-file"
printf 'not a directory\n' >"$hotspots_out_parent_file"
expect_failure_contains "--out parent path is not a directory" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --out "$hotspots_out_parent_file/startup.perf.data"
expect_failure_contains "--out parent path is not a directory" \
  env PATH="/usr/bin:/bin" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --out "$hotspots_out_parent_file/startup.perf.data"
expect_failure_contains "Missing value for --install-task" "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --install-task
expect_failure_contains "Invalid Gradle task path" "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --install-task 'app install'
expect_failure_contains "Gradle task must be an install task path" "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --install-task :app:assembleDebug
expect_failure_contains "Gradle task must be an install task path" pnpm android:perf:hotspots -- --install-task :app:assembleDebug
expect_failure_contains "Custom package launch requires --no-install or --task" \
  "$ANDROID_DIR/scripts/run-debug.sh" --package ai.openclaw.custom --activity .CustomActivity
expect_failure_contains "--task cannot be combined with --no-install" \
  "$ANDROID_DIR/scripts/run-debug.sh" --no-install --task :app:installDebug
expect_failure_contains "--task cannot be combined with --no-install" \
  pnpm android:run -- --no-install --task :app:installDebug
expect_failure_contains "Invalid Android package name" \
  "$ANDROID_DIR/scripts/run-debug.sh" --no-install --package 'ai.openclaw;custom' --activity .CustomActivity
expect_failure_contains "Invalid Android package name" \
  "$ANDROID_DIR/scripts/run-debug.sh" --no-install --package openclaw --activity .CustomActivity
expect_failure_contains "Invalid Android package name" \
  "$ANDROID_DIR/scripts/run-debug.sh" --no-install --package '_ai.openclaw' --activity .CustomActivity
expect_failure_contains "Invalid Android activity name" \
  "$ANDROID_DIR/scripts/run-debug.sh" --no-install --package ai.openclaw.custom --activity '.Custom;Activity'
expect_failure_contains "Custom package profiling requires --no-install or --install-task" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --package ai.openclaw.custom --activity .CustomActivity
expect_failure_contains "--install-task cannot be combined with --no-install" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --no-install --install-task :app:installDebug
expect_failure_contains "--install-task cannot be combined with --no-install" \
  pnpm android:perf:hotspots -- --no-install --install-task :app:installDebug
expect_failure_contains "Invalid Android package name" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --no-install --package 'ai.openclaw;custom' --activity .CustomActivity
expect_failure_contains "Invalid Android package name" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --no-install --package openclaw --activity .CustomActivity
expect_failure_contains "Invalid Android package name" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --no-install --package 'ai._openclaw' --activity .CustomActivity
expect_failure_contains "Invalid Android activity name" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --no-install --package ai.openclaw.custom --activity '.Custom;Activity'

write_fake_command jq 'echo "unexpected jq args: $*" >&2; exit 64'
write_fake_command uv 'echo "unexpected uv args: $*" >&2; exit 64'

write_fake_adb 'if [[ "${1-}" == "devices" ]]; then
  printf "List of devices attached\n"
  printf "emu-1\tdevice\n"
  printf "phone-2\tdevice\n"
  exit 0
fi
echo "unexpected adb args: $*" >&2
exit 64'
expect_failure_contains "Multiple Android devices connected" "$ANDROID_DIR/scripts/perf-startup-benchmark.sh"
expect_failure_contains "Multiple Android devices connected" "$ANDROID_DIR/scripts/perf-startup-hotspots.sh"

write_fake_adb 'if [[ "${1-}" == "devices" ]]; then
  printf "List of devices attached\n"
  printf "wanted\tdevice\n"
  printf "other\tdevice\n"
  exit 0
fi
if [[ "${1-}" == "-s" && "${2-}" == "wanted" && "${3-}" == "shell" && "${4-}" == "dumpsys" && "${5-}" == "package" ]]; then
  printf "  primaryCpuAbi=arm64-v8a\n"
  exit 0
fi
if [[ "${1-}" == "-s" && "${2-}" == "wanted" && "${3-}" == "shell" && "${4-}" == "getprop" && "${5-}" == "ro.product.cpu.abilist" ]]; then
  printf "arm64-v8a,armeabi-v7a\n"
  exit 0
fi
if [[ "${1-}" == "-s" && "${2-}" == "wanted" && "${3-}" == "shell" && "${4-}" == "getprop" && "${5-}" == "security.perf_harden" ]]; then
  if [[ -n "${OPENCLAW_FAKE_LEGACY_PERF_HARDEN_STATE:-}" ]]; then
    cat "$OPENCLAW_FAKE_LEGACY_PERF_HARDEN_STATE"
  else
    printf "1\n"
  fi
  exit 0
fi
if [[ "${1-}" == "-s" && "${2-}" == "wanted" && "${3-}" == "shell" && "${4-}" == "setprop" && "${5-}" == "security.perf_harden" && -n "${OPENCLAW_FAKE_LEGACY_PERF_HARDEN_STATE:-}" ]]; then
  value="${6-}"
  if [[ "${#value}" -eq 2 ]]; then
    value=""
  fi
  printf "%s\n" "$value" >"$OPENCLAW_FAKE_LEGACY_PERF_HARDEN_STATE"
  exit 0
fi
if [[ "${1-}" == "-s" && "${2-}" == "wanted" && "${3-}" == "shell" && "${4-}" == "whoami" ]]; then
  printf "%s\n" "${OPENCLAW_FAKE_ADB_WHOAMI:-shell}"
  exit 0
fi
if [[ "${1-}" == "unroot" && -n "${OPENCLAW_FAKE_APP_PROFILER_UNROOT_MARKER:-}" ]]; then
  printf "upstream app_profiler requested adb unroot\n" >"$OPENCLAW_FAKE_APP_PROFILER_UNROOT_MARKER"
  exit 0
fi
echo "unexpected adb args: $*" >&2
exit 64'
write_fake_gradlew
write_fake_uv_for_hotspots
write_fake_simpleperf_host_reporter
expect_failure_contains "simpleperf not found" \
  env -u ANDROID_HOME -u ANDROID_SDK_ROOT -u ANDROID_NDK_HOME -u ANDROID_NDK_ROOT \
  HOME="$TMP_DIR/no-home" \
  PATH="$TMP_DIR:/usr/bin:/bin" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --no-install
fake_sdk="$TMP_DIR/android-sdk"
partial_ndk="$TMP_DIR/partial-ndk"
older_simpleperf="$fake_sdk/ndk/9.0.0/simpleperf"
fake_simpleperf="$fake_sdk/ndk/26.1.10909125/simpleperf"
incomplete_latest_simpleperf="$fake_sdk/ndk/99.0.0/simpleperf"
mkdir -p "$partial_ndk/simpleperf" "$older_simpleperf" "$fake_simpleperf" "$incomplete_latest_simpleperf"
touch \
  "$partial_ndk/simpleperf/app_profiler.py" \
  "$older_simpleperf/app_profiler.py" \
  "$older_simpleperf/report.py" \
  "$fake_simpleperf/app_profiler.py" \
  "$fake_simpleperf/report.py" \
  "$incomplete_latest_simpleperf/app_profiler.py" \
  "$incomplete_latest_simpleperf/report.py"
install_fake_simpleperf_host_reporter "$older_simpleperf"
install_fake_simpleperf_host_reporter "$fake_simpleperf"
root_daemon_install_marker="$TMP_DIR/hotspots/root-daemon-install-marker"
write_fake_command gradlew-root-daemon 'printf "installed\n" >"'"$root_daemon_install_marker"'"
'
expect_failure_contains "Refusing to invoke Simpleperf because upstream --disable_adb_root would run 'adb unroot'" \
  env OPENCLAW_FAKE_ADB_WHOAMI=root \
  ANDROID_GRADLEW="$TMP_DIR/gradlew-root-daemon" \
  ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 \
  --out "$TMP_DIR/hotspots/root-daemon-install.perf.data"
if [[ -e "$root_daemon_install_marker" ]]; then
  fail "hotspots root-daemon preflight installed the app before refusing capture"
fi
root_daemon_unroot_marker="$TMP_DIR/hotspots/root-daemon-unroot-marker"
root_daemon_perf_data="$TMP_DIR/hotspots/root-daemon.perf.data"
mkdir -p "$(dirname -- "$root_daemon_perf_data")"
printf 'preserve root-daemon output\n' >"$root_daemon_perf_data"
expect_failure_contains "Refusing to invoke Simpleperf because upstream --disable_adb_root would run 'adb unroot'" \
  env OPENCLAW_FAKE_ADB_WHOAMI=root \
  OPENCLAW_FAKE_APP_PROFILER_UNROOT_MARKER="$root_daemon_unroot_marker" \
  ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --no-install --duration 1 \
  --out "$root_daemon_perf_data"
if [[ -e "$root_daemon_unroot_marker" ]]; then
  fail "hotspots profiling changed an already-rooted adb daemon"
fi
if [[ "$(cat "$root_daemon_perf_data")" != "preserve root-daemon output" ]]; then
  fail "root-daemon preflight replaced the prior perf data"
fi
unusable_reporter_perf_data="$TMP_DIR/hotspots/unusable-reporter.perf.data"
mkdir -p "$(dirname -- "$unusable_reporter_perf_data")"
printf 'preserve unusable reporter output\n' >"$unusable_reporter_perf_data"
expect_failure_contains "Unable to inspect the Simpleperf host reporter interface" \
  env OPENCLAW_FAKE_REPORTER_HELP_FAIL=1 OPENCLAW_FAKE_PARTIAL_CAPTURE_FAIL=1 \
  ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 --out "$unusable_reporter_perf_data"
if [[ "$(cat "$unusable_reporter_perf_data")" != "preserve unusable reporter output" ]]; then
  fail "host reporter preflight failure replaced the prior perf data"
fi
expect_failure_contains "emitted empty --help output" \
  env OPENCLAW_FAKE_REPORTER_HELP_EMPTY=1 OPENCLAW_FAKE_PARTIAL_CAPTURE_FAIL=1 \
  ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 \
  --out "$TMP_DIR/hotspots/empty-reporter-help.perf.data"
hotspots_perf_data="$TMP_DIR/hotspots/startup.perf.data"
host_report_marker="$TMP_DIR/hotspots/host-report-marker"
legacy_perf_harden_state="$TMP_DIR/hotspots/legacy-perf-harden-state"
mkdir -p "$(dirname -- "$hotspots_perf_data")"
printf 'old perf data\n' >"$hotspots_perf_data"
printf '1\n' >"$legacy_perf_harden_state"
chmod 600 "$hotspots_perf_data"
hotspots_output="$(TMPDIR="$TMP_DIR" OPENCLAW_FAKE_LEGACY_PERF_HARDEN_STATE="$legacy_perf_harden_state" OPENCLAW_FAKE_REPORT_PY_IMPORT_FAILURE=1 OPENCLAW_FAKE_HOST_REPORT_MARKER="$host_report_marker" OPENCLAW_REQUIRE_REPORT_SYMFS=1 OPENCLAW_EXPECTED_PROFILE_CWD_PREFIX="$TMP_DIR/openclaw-android-hotspots." OPENCLAW_EXPECTED_NDK_PATH="${fake_simpleperf%/simpleperf}" OPENCLAW_EXPECTED_RECORD_ARGS="-e task-clock:u -f 1000 -g --duration 1" OPENCLAW_EXPECTED_REPORT_INPUT="$hotspots_perf_data" ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_NDK_HOME="$partial_ndk" ANDROID_SDK_ROOT="$fake_sdk" run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 --out "$hotspots_perf_data" 2>&1)"
assert_contains "$hotspots_output" "device_serial=wanted" "hotspots output"
assert_contains "$hotspots_output" "adb_daemon_user=shell" "hotspots output"
assert_contains "$hotspots_output" "target_package=ai.openclaw.android" "hotspots output"
assert_contains "$hotspots_output" "target_activity=.MainActivity" "hotspots output"
assert_contains "$hotspots_output" "app_profiler_interface=legacy" "hotspots output"
assert_contains "$hotspots_output" "profile_arch=arm64" "hotspots output"
assert_contains "$hotspots_output" "duration_seconds=1" "hotspots output"
assert_contains "$hotspots_output" "ndk_path=${fake_simpleperf%/simpleperf}" "hotspots output"
assert_contains "$hotspots_output" "reporter_path=$fake_simpleperf/bin/linux/x86_64/simpleperf" "hotspots output"
assert_contains "$hotspots_output" "reporter_csv_mode=custom-separator" "hotspots output"
assert_contains "$hotspots_output" "install_task=:app:installDebug" "hotspots output"
assert_contains "$hotspots_output" "perf_data=$hotspots_perf_data" "hotspots output"
assert_contains "$hotspots_output" "62.00%  /system/lib64/libart.so" "hotspots DSO output"
assert_contains "$hotspots_output" "62.00%  /system/lib64/libart.so :: artQuickToInterpreterBridge" "hotspots symbol output"
assert_contains "$hotspots_output" "MainActivity startup path" "hotspots children output"
if [[ ! -f "$hotspots_perf_data" ]]; then
  fail "hotspots perf data was not created: $hotspots_perf_data"
fi
if [[ ! -f "$host_report_marker" ]]; then
  fail "hotspots reports did not use the bundled host simpleperf binary"
fi
if [[ "$(cat "$hotspots_perf_data")" != "fake perf data" ]]; then
  fail "successful hotspots capture did not replace the prior regular output"
fi
if [[ "$(file_permissions "$hotspots_perf_data")" != "600" ]]; then
  fail "hotspots perf data replacement did not preserve prior output permissions"
fi
if [[ "$(cat "$legacy_perf_harden_state")" != "1" ]]; then
  fail "legacy hotspots capture did not restore security.perf_harden"
fi

concurrent_perf_harden_state="$TMP_DIR/hotspots/concurrent-perf-harden-state"
concurrent_perf_harden_output="$TMP_DIR/hotspots/concurrent-perf-harden.perf.data"
printf '1\n' >"$concurrent_perf_harden_state"
printf 'preserve concurrent-state output\n' >"$concurrent_perf_harden_output"
expect_failure_contains "Refusing to overwrite concurrent device state" \
  env \
    OPENCLAW_FAKE_LEGACY_PERF_HARDEN_STATE="$concurrent_perf_harden_state" \
    OPENCLAW_FAKE_LEGACY_PERF_HARDEN_AFTER_CAPTURE=2 \
    ANDROID_SDK_ROOT="$fake_sdk" \
    "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --no-install --duration 1 \
      --out "$concurrent_perf_harden_output"
if [[ "$(cat "$concurrent_perf_harden_state")" != "2" ]]; then
  fail "legacy hotspots cleanup overwrote a concurrent security.perf_harden change"
fi
if [[ "$(cat "$concurrent_perf_harden_output")" != "preserve concurrent-state output" ]]; then
  fail "legacy hotspots cleanup published perf data after a concurrent security.perf_harden change"
fi
current_hotspots_perf_data="$TMP_DIR/hotspots/current-interface-startup.perf.data"
current_hotspots_output="$(
  umask 022
  OPENCLAW_FAKE_APP_PROFILER_INTERFACE=current \
    OPENCLAW_EXPECTED_NDK_PATH="${fake_simpleperf%/simpleperf}" \
    ANDROID_SDK_ROOT="$fake_sdk" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" \
      --serial wanted \
      --no-install \
      --duration 1 \
      --out "$current_hotspots_perf_data" 2>&1
)"
assert_contains "$current_hotspots_output" "app_profiler_interface=current" "current-interface hotspots output"
assert_contains "$current_hotspots_output" "profile_arch=auto" "current-interface hotspots output"
assert_contains "$current_hotspots_output" "install_task=skipped" "current-interface hotspots output"
assert_contains "$current_hotspots_output" "perf_data=$current_hotspots_perf_data" "current-interface hotspots output"
if [[ ! -f "$current_hotspots_perf_data" ]]; then
  fail "current-interface hotspots perf data was not created: $current_hotspots_perf_data"
fi
if [[ "$(file_permissions "$current_hotspots_perf_data")" != "600" ]]; then
  fail "new explicit hotspots perf data must remain private after publication: $current_hotspots_perf_data"
fi
legacy_reporter_hotspots_perf_data="$TMP_DIR/hotspots/legacy-reporter-startup.perf.data"
legacy_reporter_hotspots_output="$(
  OPENCLAW_FAKE_REPORTER_CSV_SEPARATOR=0 \
    OPENCLAW_FAKE_REPORT_MODE=separator_chars \
    OPENCLAW_EXPECTED_NDK_PATH="${fake_simpleperf%/simpleperf}" \
    ANDROID_SDK_ROOT="$fake_sdk" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" \
      --serial wanted \
      --no-install \
      --duration 1 \
      --out "$legacy_reporter_hotspots_perf_data" 2>&1
)"
assert_contains "$legacy_reporter_hotspots_output" "app_profiler_interface=legacy" "legacy-reporter hotspots output"
assert_contains "$legacy_reporter_hotspots_output" "reporter_csv_mode=legacy-normalized" "legacy-reporter hotspots output"
assert_contains "$legacy_reporter_hotspots_output" "62.00%  /system/lib64/libart|variant.so :: android::operator|(Flag, Flag)" "legacy-reporter hotspots symbol output"
if [[ ! -f "$legacy_reporter_hotspots_perf_data" ]]; then
  fail "legacy-reporter hotspots perf data was not created: $legacy_reporter_hotspots_perf_data"
fi
malformed_legacy_reporter_perf_data="$TMP_DIR/hotspots/malformed-legacy-reporter-startup.perf.data"
printf 'preserve malformed legacy reporter output\n' >"$malformed_legacy_reporter_perf_data"
expect_failure_contains "Failed to normalize legacy simpleperf CSV output for dso" \
  env OPENCLAW_FAKE_REPORTER_CSV_SEPARATOR=0 OPENCLAW_FAKE_REPORT_MODE=malformed_quotes \
  ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" \
  --serial wanted \
  --no-install \
  --duration 1 \
  --out "$malformed_legacy_reporter_perf_data"
if [[ "$(cat "$malformed_legacy_reporter_perf_data")" != "preserve malformed legacy reporter output" ]]; then
  fail "malformed legacy reporter replaced the prior validated perf data"
fi
text_reporter_hotspots_perf_data="$TMP_DIR/hotspots/text-reporter-startup.perf.data"
text_reporter_hotspots_output="$(
  OPENCLAW_FAKE_REPORTER_CSV=0 \
    OPENCLAW_EXPECTED_NDK_PATH="${fake_simpleperf%/simpleperf}" \
    ANDROID_SDK_ROOT="$fake_sdk" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" \
      --serial wanted \
      --no-install \
      --duration 1 \
      --out "$text_reporter_hotspots_perf_data" 2>&1
)"
assert_contains "$text_reporter_hotspots_output" "app_profiler_interface=legacy" "text-reporter hotspots output"
assert_contains "$text_reporter_hotspots_output" "reporter_csv_mode=text-normalized" "text-reporter hotspots output"
assert_contains "$text_reporter_hotspots_output" "62.00%  /system/lib64/libart old.so" "text-reporter hotspots DSO output"
assert_contains "$text_reporter_hotspots_output" "62.00%  /system/lib64/libart old.so :: android::Legacy Symbol(int)" "text-reporter hotspots symbol output"
if [[ ! -f "$text_reporter_hotspots_perf_data" ]]; then
  fail "text-reporter hotspots perf data was not created: $text_reporter_hotspots_perf_data"
fi
old_text_reporter_hotspots_perf_data="$TMP_DIR/hotspots/old-text-reporter-startup.perf.data"
old_text_reporter_hotspots_output="$(
  OPENCLAW_FAKE_REPORTER_CSV=0 \
    OPENCLAW_FAKE_REPORTER_PERCENT_LIMIT=0 \
    OPENCLAW_EXPECTED_NDK_PATH="${fake_simpleperf%/simpleperf}" \
    ANDROID_SDK_ROOT="$fake_sdk" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" \
      --serial wanted \
      --no-install \
      --duration 1 \
      --out "$old_text_reporter_hotspots_perf_data" 2>&1
)"
assert_contains "$old_text_reporter_hotspots_output" "reporter_csv_mode=text-normalized" "old text-reporter hotspots output"
assert_contains "$old_text_reporter_hotspots_output" "62.00%  /system/lib64/libart old.so :: android::Legacy Symbol(int)" "old text-reporter hotspots symbol output"
if [[ ! -f "$old_text_reporter_hotspots_perf_data" ]]; then
  fail "old text-reporter hotspots perf data was not created: $old_text_reporter_hotspots_perf_data"
fi
malformed_text_reporter_perf_data="$TMP_DIR/hotspots/malformed-text-reporter-startup.perf.data"
printf 'preserve text reporter output\n' >"$malformed_text_reporter_perf_data"
expect_failure_contains "simpleperf report for dso emitted no usable sample rows" \
  env OPENCLAW_FAKE_REPORTER_CSV=0 OPENCLAW_FAKE_REPORT_MODE=malformed \
  ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" \
  --serial wanted \
  --no-install \
  --duration 1 \
  --out "$malformed_text_reporter_perf_data"
if [[ "$(cat "$malformed_text_reporter_perf_data")" != "preserve text reporter output" ]]; then
  fail "malformed text reporter replaced the prior validated perf data"
fi
expect_failure_contains "simpleperf report for dso emitted no usable sample rows" \
  env OPENCLAW_FAKE_REPORTER_CSV=0 OPENCLAW_FAKE_REPORT_MODE=bare_overhead \
  ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" \
  --serial wanted \
  --no-install \
  --duration 1 \
  --out "$TMP_DIR/hotspots/bare-overhead-text.perf.data"
expect_failure_contains "--arch is only supported by legacy Simpleperf app_profiler.py releases" \
  env OPENCLAW_FAKE_APP_PROFILER_INTERFACE=current ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --no-install --arch arm64 --duration 1
expect_failure_contains "Unsupported Simpleperf app_profiler.py interface" \
  env OPENCLAW_FAKE_APP_PROFILER_INTERFACE=unsupported ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --no-install --duration 1
mismatched_root_sdk="$TMP_DIR/mismatched-root-sdk-for-hotspots"
mismatched_home_sdk="$TMP_DIR/mismatched-home-sdk-for-hotspots"
mismatched_home_simpleperf="$mismatched_home_sdk/ndk/27.0.12077973/simpleperf"
mkdir -p "$mismatched_root_sdk/platform-tools" "$mismatched_home_simpleperf"
cat >"$mismatched_root_sdk/platform-tools/adb" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1-}" == "devices" ]]; then
  printf "List of devices attached\n"
  printf "wanted\tdevice\n"
  exit 0
fi
if [[ "${1-}" == "-s" && "${2-}" == "wanted" && "${3-}" == "shell" && "${4-}" == "dumpsys" && "${5-}" == "package" ]]; then
  printf "  primaryCpuAbi=arm64-v8a\n"
  exit 0
fi
if [[ "${1-}" == "-s" && "${2-}" == "wanted" && "${3-}" == "shell" && "${4-}" == "getprop" && "${5-}" == "ro.product.cpu.abilist" ]]; then
  printf "arm64-v8a,armeabi-v7a\n"
  exit 0
fi
if [[ "${1-}" == "-s" && "${2-}" == "wanted" && "${3-}" == "shell" && "${4-}" == "getprop" && "${5-}" == "security.perf_harden" ]]; then
  printf "1\n"
  exit 0
fi
if [[ "${1-}" == "-s" && "${2-}" == "wanted" && "${3-}" == "shell" && "${4-}" == "whoami" ]]; then
  printf "shell\n"
  exit 0
fi
echo "unexpected mismatched-root adb args: $*" >&2
exit 64
EOF
touch \
  "$mismatched_home_simpleperf/app_profiler.py" \
  "$mismatched_home_simpleperf/report.py"
install_fake_simpleperf_host_reporter "$mismatched_home_simpleperf"
chmod +x "$mismatched_root_sdk/platform-tools/adb"
mismatched_hotspots_perf_data="$TMP_DIR/hotspots/mismatched-sdk-startup.perf.data"
mismatched_hotspots_output="$(
  OPENCLAW_EXPECTED_NDK_PATH="${mismatched_home_simpleperf%/simpleperf}" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew" \
    ANDROID_SDK_ROOT="$mismatched_root_sdk" \
    ANDROID_HOME="$mismatched_home_sdk" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" \
      --serial wanted \
      --duration 1 \
      --out "$mismatched_hotspots_perf_data" 2>&1
)"
assert_contains "$mismatched_hotspots_output" "ndk_path=${mismatched_home_simpleperf%/simpleperf}" "mismatched SDK hotspots output"
assert_contains "$mismatched_hotspots_output" "perf_data=$mismatched_hotspots_perf_data" "mismatched SDK hotspots output"
if [[ ! -f "$mismatched_hotspots_perf_data" ]]; then
  fail "mismatched SDK hotspots perf data was not created: $mismatched_hotspots_perf_data"
fi
noisy_hotspots_perf_data="$TMP_DIR/hotspots/noisy-startup.perf.data"
noisy_hotspots_output="$(
  OPENCLAW_FAKE_REPORT_MODE=noisy \
    OPENCLAW_EXPECTED_NDK_PATH="${fake_simpleperf%/simpleperf}" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew" \
    ANDROID_SDK_ROOT="$fake_sdk" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" \
      --serial wanted \
      --duration 1 \
      --out "$noisy_hotspots_perf_data" 2>&1
)"
assert_contains "$noisy_hotspots_output" "62.00%  /system/lib64/libart.so" "noisy hotspots DSO output"
assert_contains "$noisy_hotspots_output" "62.00%  /system/lib64/libart.so :: artQuickToInterpreterBridge" "noisy hotspots symbol output"
assert_not_contains "$noisy_hotspots_output" "99.00%   :: MissingDso" "noisy hotspots symbol output"
assert_not_contains "$noisy_hotspots_output" "98.00%  /bad.so :: " "noisy hotspots symbol output"
assert_not_contains "$noisy_hotspots_output" "0.00%  /zero.so" "noisy hotspots output"
if [[ ! -f "$noisy_hotspots_perf_data" ]]; then
  fail "noisy hotspots perf data was not created: $noisy_hotspots_perf_data"
fi
separator_chars_hotspots_perf_data="$TMP_DIR/hotspots/separator-chars-startup.perf.data"
separator_chars_hotspots_output="$(
  OPENCLAW_FAKE_REPORT_MODE=separator_chars \
    OPENCLAW_EXPECTED_NDK_PATH="${fake_simpleperf%/simpleperf}" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew" \
    ANDROID_SDK_ROOT="$fake_sdk" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" \
      --serial wanted \
      --duration 1 \
      --out "$separator_chars_hotspots_perf_data" 2>&1
)"
assert_contains "$separator_chars_hotspots_output" "62.00%  /system/lib64/libart|variant.so" "separator-character hotspots DSO output"
assert_contains "$separator_chars_hotspots_output" "62.00%  /system/lib64/libart|variant.so :: android::operator|(Flag, Flag)" "separator-character hotspots symbol output"
if [[ ! -f "$separator_chars_hotspots_perf_data" ]]; then
  fail "separator-character hotspots perf data was not created: $separator_chars_hotspots_perf_data"
fi
no_clues_hotspots_perf_data="$TMP_DIR/hotspots/no-clues-startup.perf.data"
no_clues_hotspots_output="$(
  OPENCLAW_FAKE_CHILDREN_MODE=none \
    OPENCLAW_EXPECTED_NDK_PATH="${fake_simpleperf%/simpleperf}" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew" \
    ANDROID_SDK_ROOT="$fake_sdk" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" \
      --serial wanted \
      --duration 1 \
      --out "$no_clues_hotspots_perf_data" 2>&1
)"
assert_contains "$no_clues_hotspots_output" $'app_path_clues_children:\n  none' "no-clues hotspots output"
if [[ ! -f "$no_clues_hotspots_perf_data" ]]; then
  fail "no-clues hotspots perf data was not created: $no_clues_hotspots_perf_data"
fi
zero_clue_hotspots_perf_data="$TMP_DIR/hotspots/zero-clue-startup.perf.data"
zero_clue_hotspots_output="$(
  OPENCLAW_FAKE_CHILDREN_MODE=zero_then_valid \
    OPENCLAW_EXPECTED_NDK_PATH="${fake_simpleperf%/simpleperf}" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew" \
    ANDROID_SDK_ROOT="$fake_sdk" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" \
      --serial wanted \
      --duration 1 \
      --out "$zero_clue_hotspots_perf_data" 2>&1
)"
assert_contains "$zero_clue_hotspots_output" $'app_path_clues_children:\n  none' "zero-clue hotspots output"
assert_not_contains "$zero_clue_hotspots_output" "MainActivity zero-sample path" "zero-clue hotspots output"
if [[ ! -f "$zero_clue_hotspots_perf_data" ]]; then
  fail "zero-clue hotspots perf data was not created: $zero_clue_hotspots_perf_data"
fi
home_root_ndk="$TMP_DIR/home-root-ndk"
home_root_simpleperf="$home_root_ndk/simpleperf"
mkdir -p "$home_root_simpleperf"
touch "$home_root_simpleperf/app_profiler.py" "$home_root_simpleperf/report.py"
install_fake_simpleperf_host_reporter "$home_root_simpleperf"
home_root_hotspots_perf_data="$TMP_DIR/hotspots/home-root-ndk-startup.perf.data"
home_root_hotspots_output="$(
  OPENCLAW_EXPECTED_NDK_PATH="$home_root_ndk" \
    ANDROID_NDK_HOME="$home_root_ndk" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" \
      --serial wanted \
      --duration 1 \
      --out "$home_root_hotspots_perf_data" 2>&1
)"
assert_contains "$home_root_hotspots_output" "ndk_path=$home_root_ndk" "ANDROID_NDK_HOME root hotspots output"
assert_contains "$home_root_hotspots_output" "perf_data=$home_root_hotspots_perf_data" "ANDROID_NDK_HOME root hotspots output"
if [[ ! -f "$home_root_hotspots_perf_data" ]]; then
  fail "ANDROID_NDK_HOME root hotspots perf data was not created: $home_root_hotspots_perf_data"
fi
direct_ndk="$TMP_DIR/direct-ndk"
direct_simpleperf="$direct_ndk/simpleperf"
mkdir -p "$direct_simpleperf"
touch "$direct_simpleperf/app_profiler.py" "$direct_simpleperf/report.py"
install_fake_simpleperf_host_reporter "$direct_simpleperf"
direct_ndk_hotspots_perf_data="$TMP_DIR/hotspots/direct-ndk-startup.perf.data"
direct_ndk_hotspots_output="$(
  OPENCLAW_EXPECTED_NDK_PATH="$direct_ndk" \
    ANDROID_NDK_ROOT="$direct_simpleperf" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" \
      --serial wanted \
      --duration 1 \
      --out "$direct_ndk_hotspots_perf_data" 2>&1
)"
assert_contains "$direct_ndk_hotspots_output" "perf_data=$direct_ndk_hotspots_perf_data" "direct NDK hotspots output"
if [[ ! -f "$direct_ndk_hotspots_perf_data" ]]; then
  fail "direct NDK hotspots perf data was not created: $direct_ndk_hotspots_perf_data"
fi
direct_custom_named_simpleperf="$TMP_DIR/direct-simpleperf-custom-name"
mkdir -p "$direct_custom_named_simpleperf"
touch "$direct_custom_named_simpleperf/app_profiler.py" "$direct_custom_named_simpleperf/report.py"
install_fake_simpleperf_host_reporter "$direct_custom_named_simpleperf"
direct_custom_named_hotspots_perf_data="$TMP_DIR/hotspots/direct-custom-named-simpleperf-startup.perf.data"
direct_custom_named_hotspots_output="$(
  OPENCLAW_EXPECTED_NDK_PATH="$TMP_DIR" \
    ANDROID_NDK_HOME="$direct_custom_named_simpleperf" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" \
      --serial wanted \
      --duration 1 \
      --out "$direct_custom_named_hotspots_perf_data" 2>&1
)"
assert_contains "$direct_custom_named_hotspots_output" "perf_data=$direct_custom_named_hotspots_perf_data" "direct custom-named simpleperf hotspots output"
if [[ ! -f "$direct_custom_named_hotspots_perf_data" ]]; then
  fail "direct custom-named simpleperf hotspots perf data was not created: $direct_custom_named_hotspots_perf_data"
fi
home_direct_ndk="$TMP_DIR/home-direct-ndk"
home_direct_simpleperf="$home_direct_ndk/simpleperf"
mkdir -p "$home_direct_simpleperf"
touch "$home_direct_simpleperf/app_profiler.py" "$home_direct_simpleperf/report.py"
install_fake_simpleperf_host_reporter "$home_direct_simpleperf"
home_direct_hotspots_perf_data="$TMP_DIR/hotspots/home-direct-ndk-startup.perf.data"
home_direct_hotspots_output="$(
  OPENCLAW_EXPECTED_NDK_PATH="$home_direct_ndk" \
    ANDROID_NDK_HOME="$home_direct_simpleperf" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew" \
    ANDROID_SDK_ROOT="$fake_sdk" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" \
      --serial wanted \
      --duration 1 \
      --out "$home_direct_hotspots_perf_data" 2>&1
)"
assert_contains "$home_direct_hotspots_output" "perf_data=$home_direct_hotspots_perf_data" "direct ANDROID_NDK_HOME hotspots output"
if [[ ! -f "$home_direct_hotspots_perf_data" ]]; then
  fail "direct ANDROID_NDK_HOME hotspots perf data was not created: $home_direct_hotspots_perf_data"
fi
symlink_target_ndk="$TMP_DIR/symlink-target-ndk"
symlink_target_simpleperf="$symlink_target_ndk/simpleperf"
symlink_direct_simpleperf="$TMP_DIR/symlink-direct-simpleperf"
mkdir -p "$symlink_target_simpleperf"
touch "$symlink_target_simpleperf/app_profiler.py" "$symlink_target_simpleperf/report.py"
install_fake_simpleperf_host_reporter "$symlink_target_simpleperf"
ln -s "$symlink_target_simpleperf" "$symlink_direct_simpleperf"
symlink_direct_hotspots_perf_data="$TMP_DIR/hotspots/symlink-direct-simpleperf-startup.perf.data"
symlink_direct_hotspots_output="$(
  OPENCLAW_FAKE_APP_PROFILER_INTERFACE=current \
    OPENCLAW_EXPECTED_NDK_PATH="$symlink_target_ndk" \
    ANDROID_NDK_HOME="$symlink_direct_simpleperf" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" \
      --serial wanted \
      --duration 1 \
      --out "$symlink_direct_hotspots_perf_data" 2>&1
)"
assert_contains "$symlink_direct_hotspots_output" "ndk_path=$symlink_target_ndk" "symlinked direct ANDROID_NDK_HOME hotspots output"
if [[ ! -f "$symlink_direct_hotspots_perf_data" ]]; then
  fail "symlinked direct ANDROID_NDK_HOME hotspots perf data was not created: $symlink_direct_hotspots_perf_data"
fi
relative_direct_ndk="$TMP_DIR/relative-direct-ndk"
relative_direct_simpleperf="$relative_direct_ndk/simpleperf"
mkdir -p "$relative_direct_simpleperf"
touch "$relative_direct_simpleperf/app_profiler.py" "$relative_direct_simpleperf/report.py"
install_fake_simpleperf_host_reporter "$relative_direct_simpleperf"
relative_direct_hotspots_perf_data="$TMP_DIR/hotspots/relative-direct-ndk-startup.perf.data"
relative_direct_hotspots_output="$(
  cd "$TMP_DIR"
  OPENCLAW_EXPECTED_NDK_PATH="$relative_direct_ndk" \
    ANDROID_NDK_HOME="relative-direct-ndk/simpleperf" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" \
      --serial wanted \
      --duration 1 \
      --out "$relative_direct_hotspots_perf_data" 2>&1
)"
assert_contains "$relative_direct_hotspots_output" "perf_data=$relative_direct_hotspots_perf_data" "relative direct ANDROID_NDK_HOME hotspots output"
if [[ ! -f "$relative_direct_hotspots_perf_data" ]]; then
  fail "relative direct ANDROID_NDK_HOME hotspots perf data was not created: $relative_direct_hotspots_perf_data"
fi
relative_root_ndk="$TMP_DIR/relative-root-ndk"
relative_root_simpleperf="$relative_root_ndk/simpleperf"
mkdir -p "$relative_root_simpleperf"
touch "$relative_root_simpleperf/app_profiler.py" "$relative_root_simpleperf/report.py"
install_fake_simpleperf_host_reporter "$relative_root_simpleperf"
relative_root_hotspots_perf_data="$TMP_DIR/hotspots/relative-root-ndk-startup.perf.data"
relative_root_hotspots_output="$(
  cd "$TMP_DIR"
  OPENCLAW_EXPECTED_NDK_PATH="$relative_root_ndk" \
    ANDROID_NDK_ROOT="relative-root-ndk" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" \
      --serial wanted \
      --duration 1 \
      --out "$relative_root_hotspots_perf_data" 2>&1
)"
assert_contains "$relative_root_hotspots_output" "perf_data=$relative_root_hotspots_perf_data" "relative root ANDROID_NDK_ROOT hotspots output"
if [[ ! -f "$relative_root_hotspots_perf_data" ]]; then
  fail "relative root ANDROID_NDK_ROOT hotspots perf data was not created: $relative_root_hotspots_perf_data"
fi
hotspots_env_serial_perf_data="$TMP_DIR/hotspots/env-serial-startup.perf.data"
hotspots_env_serial_output="$(OPENCLAW_EXPECTED_NDK_PATH="${fake_simpleperf%/simpleperf}" ANDROID_SERIAL=wanted ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_SDK_ROOT="$fake_sdk" run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --duration 1 --out "$hotspots_env_serial_perf_data" 2>&1)"
assert_contains "$hotspots_env_serial_output" "device_serial=wanted" "ANDROID_SERIAL hotspots output"
assert_contains "$hotspots_env_serial_output" "perf_data=$hotspots_env_serial_perf_data" "ANDROID_SERIAL hotspots output"
if [[ ! -f "$hotspots_env_serial_perf_data" ]]; then
  fail "ANDROID_SERIAL hotspots perf data was not created: $hotspots_env_serial_perf_data"
fi
custom_hotspots_perf_data="$TMP_DIR/hotspots/custom-startup.perf.data"
custom_hotspots_output="$(
  OPENCLAW_EXPECTED_NDK_PATH="${fake_simpleperf%/simpleperf}" \
    OPENCLAW_EXPECTED_PROFILE_PACKAGE="ai.openclaw.custom" \
    OPENCLAW_EXPECTED_PROFILE_ACTIVITY=".CustomActivity" \
    OPENCLAW_EXPECTED_PROFILE_ARCH="x86" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew" \
    ANDROID_SDK_ROOT="$fake_sdk" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" \
      --serial wanted \
      --duration 1 \
      --arch x86 \
      --package ai.openclaw.custom \
      --activity CustomActivity \
      --no-install \
      --out "$custom_hotspots_perf_data" 2>&1
)"
assert_contains "$custom_hotspots_output" "target_package=ai.openclaw.custom" "custom hotspots output"
assert_contains "$custom_hotspots_output" "target_activity=.CustomActivity" "custom hotspots output"
assert_contains "$custom_hotspots_output" "profile_arch=x86" "custom hotspots output"
assert_contains "$custom_hotspots_output" "duration_seconds=1" "custom hotspots output"
assert_contains "$custom_hotspots_output" "ndk_path=${fake_simpleperf%/simpleperf}" "custom hotspots output"
assert_contains "$custom_hotspots_output" "install_task=skipped" "custom hotspots output"
assert_contains "$custom_hotspots_output" "perf_data=$custom_hotspots_perf_data" "custom hotspots output"
if [[ ! -f "$custom_hotspots_perf_data" ]]; then
  fail "custom hotspots perf data was not created: $custom_hotspots_perf_data"
fi
nested_activity_hotspots_perf_data="$TMP_DIR/hotspots/nested-activity-startup.perf.data"
nested_activity_hotspots_output="$(
  OPENCLAW_EXPECTED_NDK_PATH="${fake_simpleperf%/simpleperf}" \
    OPENCLAW_EXPECTED_PROFILE_PACKAGE="ai.openclaw.custom" \
    OPENCLAW_EXPECTED_PROFILE_ACTIVITY='.Outer\$Inner' \
    OPENCLAW_EXPECTED_PROFILE_ARCH="x86" \
    ANDROID_GRADLEW="$TMP_DIR/missing-gradlew" \
    ANDROID_SDK_ROOT="$fake_sdk" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" \
      --serial wanted \
      --duration 1 \
      --arch x86 \
      --package ai.openclaw.custom \
      --activity 'Outer$Inner' \
      --no-install \
      --out "$nested_activity_hotspots_perf_data" 2>&1
)"
assert_contains "$nested_activity_hotspots_output" 'target_activity=.Outer$Inner' "nested activity hotspots output"
if [[ ! -f "$nested_activity_hotspots_perf_data" ]]; then
  fail "nested activity hotspots perf data was not created: $nested_activity_hotspots_perf_data"
fi
relative_out_hotspots_perf_data="$TMP_DIR/relative-hotspots/startup.perf.data"
relative_out_hotspots_output="$(
  cd "$TMP_DIR"
  OPENCLAW_EXPECTED_NDK_PATH="${fake_simpleperf%/simpleperf}" \
    OPENCLAW_EXPECTED_REPORT_INPUT="$relative_out_hotspots_perf_data" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew" \
    ANDROID_SDK_ROOT="$fake_sdk" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" \
      --serial wanted \
      --duration 1 \
      --out relative-hotspots/startup.perf.data \
      2>&1
)"
assert_contains "$relative_out_hotspots_output" "perf_data=$relative_out_hotspots_perf_data" "relative --out hotspots output"
if [[ ! -f "$relative_out_hotspots_perf_data" ]]; then
  fail "relative --out hotspots perf data was not created: $relative_out_hotspots_perf_data"
fi
no_install_hotspots_perf_data="$TMP_DIR/hotspots/no-install-startup.perf.data"
no_install_hotspots_output="$(
  OPENCLAW_EXPECTED_NDK_PATH="${fake_simpleperf%/simpleperf}" \
    OPENCLAW_EXPECTED_PROFILE_PACKAGE="ai.openclaw.custom" \
    OPENCLAW_EXPECTED_PROFILE_ACTIVITY=".CustomActivity" \
    ANDROID_GRADLEW="$TMP_DIR/missing-gradlew" \
    ANDROID_SDK_ROOT="$fake_sdk" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" \
      --serial wanted \
      --duration 1 \
      --package ai.openclaw.custom \
      --activity .CustomActivity \
      --no-install \
      --out "$no_install_hotspots_perf_data" 2>&1
)"
assert_contains "$no_install_hotspots_output" "perf_data=$no_install_hotspots_perf_data" "no-install hotspots output"
if [[ ! -f "$no_install_hotspots_perf_data" ]]; then
  fail "no-install hotspots perf data was not created: $no_install_hotspots_perf_data"
fi
no_sdk_no_install_hotspots_perf_data="$TMP_DIR/hotspots/no-sdk-no-install-startup.perf.data"
no_sdk_no_install_hotspots_output="$(
  env -u ANDROID_HOME -u ANDROID_SDK_ROOT \
    HOME="$TMP_DIR/no-home" \
    OPENCLAW_EXPECTED_NDK_PATH="$direct_ndk" \
    OPENCLAW_EXPECTED_PROFILE_PACKAGE="ai.openclaw.custom" \
    OPENCLAW_EXPECTED_PROFILE_ACTIVITY=".CustomActivity" \
    ANDROID_NDK_ROOT="$direct_simpleperf" \
    ANDROID_GRADLEW="$TMP_DIR/missing-gradlew" \
    PATH="$TMP_DIR:$PATH" \
    "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" \
      --serial wanted \
      --duration 1 \
      --package ai.openclaw.custom \
      --activity .CustomActivity \
      --no-install \
      --out "$no_sdk_no_install_hotspots_perf_data" 2>&1
)"
assert_contains "$no_sdk_no_install_hotspots_output" "install_task=skipped" "no-SDK no-install hotspots output"
assert_contains "$no_sdk_no_install_hotspots_output" "perf_data=$no_sdk_no_install_hotspots_perf_data" "no-SDK no-install hotspots output"
if [[ ! -f "$no_sdk_no_install_hotspots_perf_data" ]]; then
  fail "no-SDK no-install hotspots perf data was not created: $no_sdk_no_install_hotspots_perf_data"
fi
default_no_sdk_no_install_hotspots_perf_data="$TMP_DIR/hotspots/default-no-sdk-no-install-startup.perf.data"
default_no_sdk_no_install_hotspots_output="$(
  env -u ANDROID_HOME -u ANDROID_SDK_ROOT \
    HOME="$TMP_DIR/no-home" \
    OPENCLAW_EXPECTED_NDK_PATH="$direct_ndk" \
    ANDROID_NDK_ROOT="$direct_simpleperf" \
    ANDROID_GRADLEW="$TMP_DIR/missing-gradlew" \
    PATH="$TMP_DIR:$PATH" \
    "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" \
      --serial wanted \
      --duration 1 \
      --no-install \
      --out "$default_no_sdk_no_install_hotspots_perf_data" 2>&1
)"
assert_contains "$default_no_sdk_no_install_hotspots_output" "target_package=ai.openclaw.android" "default no-SDK no-install hotspots output"
assert_contains "$default_no_sdk_no_install_hotspots_output" "install_task=skipped" "default no-SDK no-install hotspots output"
assert_contains "$default_no_sdk_no_install_hotspots_output" "perf_data=$default_no_sdk_no_install_hotspots_perf_data" "default no-SDK no-install hotspots output"
if [[ ! -f "$default_no_sdk_no_install_hotspots_perf_data" ]]; then
  fail "default no-SDK no-install hotspots perf data was not created: $default_no_sdk_no_install_hotspots_perf_data"
fi
install_task_marker="$TMP_DIR/hotspots/install-task-marker"
write_fake_command gradlew-hotspots-install-task 'if [[ "${ANDROID_SERIAL-}" != "wanted" ]]; then
  echo "unexpected ANDROID_SERIAL: ${ANDROID_SERIAL-}" >&2
  exit 65
fi
if [[ "$*" != ":benchmark:installDebug -Pandroid.injected.device.serial=wanted --console=plain" ]]; then
  echo "unexpected install-task gradlew args: $*" >&2
  exit 64
fi
printf "installed\n" >"'"$install_task_marker"'"
'
install_task_hotspots_perf_data="$TMP_DIR/hotspots/install-task-startup.perf.data"
install_task_hotspots_output="$(
  OPENCLAW_EXPECTED_NDK_PATH="${fake_simpleperf%/simpleperf}" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew-hotspots-install-task" \
    ANDROID_SDK_ROOT="$fake_sdk" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" \
      --serial wanted \
      --duration 1 \
      --install-task :benchmark:installDebug \
      --out "$install_task_hotspots_perf_data" 2>&1
)"
assert_contains "$install_task_hotspots_output" "perf_data=$install_task_hotspots_perf_data" "install-task hotspots output"
if [[ ! -f "$install_task_marker" ]]; then
  fail "custom hotspots install task was not invoked"
fi
custom_install_task_marker="$TMP_DIR/hotspots/custom-install-task-marker"
write_fake_command gradlew-hotspots-custom-install-task 'if [[ "${ANDROID_SERIAL-}" != "wanted" ]]; then
  echo "unexpected ANDROID_SERIAL: ${ANDROID_SERIAL-}" >&2
  exit 65
fi
if [[ "$*" != ":custom:installDebug -Pandroid.injected.device.serial=wanted --console=plain" ]]; then
  echo "unexpected custom install-task gradlew args: $*" >&2
  exit 64
fi
printf "installed\n" >"'"$custom_install_task_marker"'"
'
custom_install_task_hotspots_perf_data="$TMP_DIR/hotspots/custom-install-task-startup.perf.data"
custom_install_task_hotspots_output="$(
  OPENCLAW_EXPECTED_NDK_PATH="${fake_simpleperf%/simpleperf}" \
    OPENCLAW_EXPECTED_PROFILE_PACKAGE="ai.openclaw.custom" \
    OPENCLAW_EXPECTED_PROFILE_ACTIVITY=".CustomActivity" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew-hotspots-custom-install-task" \
    ANDROID_SDK_ROOT="$fake_sdk" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" \
      --serial wanted \
      --duration 1 \
      --package ai.openclaw.custom \
      --activity .CustomActivity \
      --install-task :custom:installDebug \
      --out "$custom_install_task_hotspots_perf_data" 2>&1
)"
assert_contains "$custom_install_task_hotspots_output" "target_package=ai.openclaw.custom" "custom install-task hotspots output"
assert_contains "$custom_install_task_hotspots_output" "target_activity=.CustomActivity" "custom install-task hotspots output"
assert_contains "$custom_install_task_hotspots_output" "install_task=:custom:installDebug" "custom install-task hotspots output"
assert_contains "$custom_install_task_hotspots_output" "perf_data=$custom_install_task_hotspots_perf_data" "custom install-task hotspots output"
if [[ ! -f "$custom_install_task_marker" ]]; then
  fail "custom package hotspots install task was not invoked"
fi
pnpm_hotspots_perf_data="$TMP_DIR/hotspots/pnpm-startup.perf.data"
pnpm_hotspots_output="$(OPENCLAW_EXPECTED_NDK_PATH="${fake_simpleperf%/simpleperf}" ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_SDK_ROOT="$fake_sdk" run_with_fake_adb pnpm android:perf:hotspots -- --serial wanted --duration 1 --out "$pnpm_hotspots_perf_data" 2>&1)"
assert_contains "$pnpm_hotspots_output" "device_serial=wanted" "pnpm android:perf:hotspots output"
assert_contains "$pnpm_hotspots_output" "perf_data=$pnpm_hotspots_perf_data" "pnpm android:perf:hotspots output"
assert_contains "$pnpm_hotspots_output" "62.00%  /system/lib64/libart.so :: artQuickToInterpreterBridge" "pnpm android:perf:hotspots output"
if [[ ! -f "$pnpm_hotspots_perf_data" ]]; then
  fail "pnpm hotspots perf data was not created: $pnpm_hotspots_perf_data"
fi
pnpm_repo_relative_hotspots_perf_data="$SHELL_TOOLS_BENCHMARK_OUTPUT_RELATIVE/pnpm-relative-startup.perf.data"
pnpm_repo_relative_hotspots_perf_data_abs="$ROOT_DIR/$pnpm_repo_relative_hotspots_perf_data"
pnpm_repo_relative_hotspots_output="$(
  OPENCLAW_EXPECTED_NDK_PATH="${fake_simpleperf%/simpleperf}" \
    OPENCLAW_EXPECTED_REPORT_INPUT="$pnpm_repo_relative_hotspots_perf_data_abs" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew" \
    ANDROID_SDK_ROOT="$fake_sdk" \
    run_with_fake_adb pnpm android:perf:hotspots -- \
      --serial wanted \
      --duration 1 \
      --out "$pnpm_repo_relative_hotspots_perf_data" 2>&1
)"
assert_contains "$pnpm_repo_relative_hotspots_output" "perf_data=$pnpm_repo_relative_hotspots_perf_data_abs" "pnpm repo-relative hotspots output"
if [[ ! -f "$pnpm_repo_relative_hotspots_perf_data_abs" ]]; then
  fail "pnpm repo-relative hotspots perf data was not created: $pnpm_repo_relative_hotspots_perf_data_abs"
fi
pnpm_install_task_hotspots_marker="$TMP_DIR/hotspots/pnpm-install-task-marker"
write_fake_command gradlew-pnpm-hotspots-install-task 'if [[ "${ANDROID_SERIAL-}" != "wanted" ]]; then
  echo "unexpected ANDROID_SERIAL: ${ANDROID_SERIAL-}" >&2
  exit 65
fi
if [[ "$*" != ":benchmark:installDebug -Pandroid.injected.device.serial=wanted --console=plain" ]]; then
  echo "unexpected pnpm install-task gradlew args: $*" >&2
  exit 64
fi
printf "installed\n" >"'"$pnpm_install_task_hotspots_marker"'"
'
pnpm_install_task_hotspots_perf_data="$TMP_DIR/hotspots/pnpm-install-task-startup.perf.data"
pnpm_install_task_hotspots_output="$(
  OPENCLAW_EXPECTED_NDK_PATH="${fake_simpleperf%/simpleperf}" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew-pnpm-hotspots-install-task" \
    ANDROID_SDK_ROOT="$fake_sdk" \
    run_with_fake_adb pnpm android:perf:hotspots -- \
      --serial wanted \
      --duration 1 \
      --install-task :benchmark:installDebug \
      --out "$pnpm_install_task_hotspots_perf_data" 2>&1
)"
assert_contains "$pnpm_install_task_hotspots_output" "install_task=:benchmark:installDebug" "pnpm android:perf:hotspots install-task output"
assert_contains "$pnpm_install_task_hotspots_output" "perf_data=$pnpm_install_task_hotspots_perf_data" "pnpm android:perf:hotspots install-task output"
if [[ ! -f "$pnpm_install_task_hotspots_marker" ]]; then
  fail "pnpm hotspots install task was not invoked"
fi
if [[ ! -f "$pnpm_install_task_hotspots_perf_data" ]]; then
  fail "pnpm install-task hotspots perf data was not created: $pnpm_install_task_hotspots_perf_data"
fi
pnpm_custom_hotspots_perf_data="$TMP_DIR/hotspots/pnpm-custom-startup.perf.data"
pnpm_custom_hotspots_output="$(
  OPENCLAW_EXPECTED_NDK_PATH="${fake_simpleperf%/simpleperf}" \
    OPENCLAW_EXPECTED_PROFILE_PACKAGE="ai.openclaw.custom" \
    OPENCLAW_EXPECTED_PROFILE_ACTIVITY=".CustomActivity" \
    ANDROID_GRADLEW="$TMP_DIR/missing-gradlew" \
    ANDROID_SDK_ROOT="$fake_sdk" \
    run_with_fake_adb pnpm android:perf:hotspots -- \
      --serial wanted \
      --duration 1 \
      --package ai.openclaw.custom \
      --activity .CustomActivity \
      --no-install \
      --out "$pnpm_custom_hotspots_perf_data" 2>&1
)"
assert_contains "$pnpm_custom_hotspots_output" "target_package=ai.openclaw.custom" "pnpm custom hotspots output"
assert_contains "$pnpm_custom_hotspots_output" "target_activity=.CustomActivity" "pnpm custom hotspots output"
assert_contains "$pnpm_custom_hotspots_output" "install_task=skipped" "pnpm custom hotspots output"
assert_contains "$pnpm_custom_hotspots_output" "perf_data=$pnpm_custom_hotspots_perf_data" "pnpm custom hotspots output"
if [[ ! -f "$pnpm_custom_hotspots_perf_data" ]]; then
  fail "pnpm custom hotspots perf data was not created: $pnpm_custom_hotspots_perf_data"
fi
hotspots_default_output_one="$(
  umask 022
  OPENCLAW_EXPECTED_NDK_PATH="${fake_simpleperf%/simpleperf}" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew" \
    ANDROID_SDK_ROOT="$fake_sdk" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 2>&1
)"
hotspots_default_output_two="$(OPENCLAW_EXPECTED_NDK_PATH="${fake_simpleperf%/simpleperf}" ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_SDK_ROOT="$fake_sdk" run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 2>&1)"
hotspots_default_perf_one="$(printf '%s\n' "$hotspots_default_output_one" | awk -F= '/^perf_data=/{print $2; exit}')"
hotspots_default_perf_two="$(printf '%s\n' "$hotspots_default_output_two" | awk -F= '/^perf_data=/{print $2; exit}')"
if [[ -z "$hotspots_default_perf_one" || ! -f "$hotspots_default_perf_one" ]]; then
  fail "first default hotspots perf data was not created: $hotspots_default_perf_one"
fi
if [[ -z "$hotspots_default_perf_two" || ! -f "$hotspots_default_perf_two" ]]; then
  fail "second default hotspots perf data was not created: $hotspots_default_perf_two"
fi
if [[ "$hotspots_default_perf_one" == "$hotspots_default_perf_two" ]]; then
  fail "hotspots default perf data paths collided under same-second timestamp: $hotspots_default_perf_one"
fi
if [[ "$(file_permissions "$hotspots_default_perf_one")" != "600" ]]; then
  fail "default hotspots perf data must remain private after publication: $hotspots_default_perf_one"
fi
CLEANUP_FILES+=("$hotspots_default_perf_one" "$hotspots_default_perf_two")
hotspots_default_tmpdir="$TMP_DIR/hotspots-default-tmpdir"
mkdir -p "$hotspots_default_tmpdir"
hotspots_default_tmpdir_output="$(
  TMPDIR="$hotspots_default_tmpdir" \
    OPENCLAW_EXPECTED_NDK_PATH="${fake_simpleperf%/simpleperf}" \
    ANDROID_GRADLEW="$TMP_DIR/gradlew" \
    ANDROID_SDK_ROOT="$fake_sdk" \
    run_with_fake_adb "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 2>&1
)"
hotspots_default_tmpdir_perf_data="$(printf '%s\n' "$hotspots_default_tmpdir_output" | awk -F= '/^perf_data=/{print $2; exit}')"
if [[ -n "$hotspots_default_tmpdir_perf_data" ]]; then
  CLEANUP_FILES+=("$hotspots_default_tmpdir_perf_data")
fi
case "$hotspots_default_tmpdir_perf_data" in
  "$hotspots_default_tmpdir"/openclaw-startup-*.perf.data)
    ;;
  *)
    fail "hotspots default perf data ignored TMPDIR: $hotspots_default_tmpdir_perf_data"
    ;;
esac
if [[ ! -f "$hotspots_default_tmpdir_perf_data" ]]; then
  fail "TMPDIR-scoped default hotspots perf data was not created: $hotspots_default_tmpdir_perf_data"
fi
hotspots_failed_default_tmpdir="$TMP_DIR/hotspots-failed-default-tmpdir"
mkdir -p "$hotspots_failed_default_tmpdir"
expect_failure_contains "simpleperf report for dso emitted no usable sample rows" \
  env TMPDIR="$hotspots_failed_default_tmpdir" OPENCLAW_FAKE_REPORT_MODE=empty \
  ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1
if compgen -G "$hotspots_failed_default_tmpdir/openclaw-startup-*.perf.data" >/dev/null; then
  fail "failed hotspots report leaked its reserved default perf data path"
fi
expect_failure_contains "simpleperf report for dso emitted no usable sample rows" \
  env OPENCLAW_FAKE_REPORT_MODE=empty ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 --out "$TMP_DIR/hotspots/empty.perf.data"
if [[ -e "$TMP_DIR/hotspots/empty.perf.data" ]]; then
  fail "failed hotspots report left a new unvalidated perf data file"
fi
stale_report_perf_data="$TMP_DIR/hotspots/stale-report.perf.data"
printf 'stale report perf data\n' >"$stale_report_perf_data"
expect_failure_contains "simpleperf report for dso emitted no usable sample rows" \
  env OPENCLAW_FAKE_REPORT_MODE=empty ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 --out "$stale_report_perf_data"
if [[ "$(cat "$stale_report_perf_data")" != "stale report perf data" ]]; then
  fail "failed hotspots report replaced the prior validated perf data"
fi
expect_failure_contains "simpleperf report for dso emitted no usable sample rows" \
  env OPENCLAW_FAKE_REPORT_MODE=malformed ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 --out "$TMP_DIR/hotspots/malformed.perf.data"
expect_failure_contains "simpleperf report for dso emitted no usable sample rows" \
  env OPENCLAW_FAKE_REPORT_MODE=bad_overhead ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 --out "$TMP_DIR/hotspots/bad-overhead.perf.data"
out_of_range_perf_data="$TMP_DIR/hotspots/out-of-range.perf.data"
expect_failure_contains "simpleperf report for dso emitted no usable sample rows" \
  env OPENCLAW_FAKE_REPORT_MODE=out_of_range ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 --out "$out_of_range_perf_data"
if [[ -e "$out_of_range_perf_data" ]]; then
  fail "out-of-range self-time report published unvalidated perf data"
fi
zero_percent_perf_data="$TMP_DIR/hotspots/zero-percent.perf.data"
expect_failure_contains "simpleperf report for dso emitted no usable sample rows" \
  env OPENCLAW_FAKE_REPORT_MODE=zero ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 --out "$zero_percent_perf_data"
if [[ -e "$zero_percent_perf_data" ]]; then
  fail "zero-percent self-time report published unvalidated perf data"
fi
expect_failure_contains "simpleperf report for dso emitted no usable sample rows" \
  env OPENCLAW_FAKE_REPORT_MODE=bare_overhead ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 --out "$TMP_DIR/hotspots/bare-overhead.perf.data"
expect_failure_contains "simpleperf report for dso emitted no usable sample rows" \
  env OPENCLAW_FAKE_REPORT_MODE=header_drift ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 --out "$TMP_DIR/hotspots/header-drift.perf.data"
expect_failure_contains "simpleperf report for dso,symbol emitted no usable sample rows" \
  env OPENCLAW_FAKE_REPORT_MODE=dso_only ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 --out "$TMP_DIR/hotspots/dso-only.perf.data"
expect_failure_contains "simpleperf report for dso did not emit the expected CSV header" \
  env OPENCLAW_FAKE_REPORT_MODE=noheader ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 --out "$TMP_DIR/hotspots/noheader.perf.data"
expect_failure_contains "simpleperf report for children emitted no usable sample rows" \
  env OPENCLAW_FAKE_CHILDREN_MODE=empty ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 --out "$TMP_DIR/hotspots/empty-children.perf.data"
expect_failure_contains "simpleperf report for children emitted no usable sample rows" \
  env OPENCLAW_FAKE_CHILDREN_MODE=malformed ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 --out "$TMP_DIR/hotspots/malformed-children.perf.data"
percent_only_children_perf_data="$TMP_DIR/hotspots/percent-only-children.perf.data"
expect_failure_contains "simpleperf report for children emitted no usable sample rows" \
  env OPENCLAW_FAKE_CHILDREN_MODE=percent_only ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 --out "$percent_only_children_perf_data"
if [[ -e "$percent_only_children_perf_data" ]]; then
  fail "malformed percentage-only children report published unvalidated perf data"
fi
out_of_range_children_perf_data="$TMP_DIR/hotspots/out-of-range-children.perf.data"
expect_failure_contains "simpleperf report for children emitted no usable sample rows" \
  env OPENCLAW_FAKE_CHILDREN_MODE=out_of_range ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 --out "$out_of_range_children_perf_data"
if [[ -e "$out_of_range_children_perf_data" ]]; then
  fail "out-of-range children report published unvalidated perf data"
fi
zero_percent_children_perf_data="$TMP_DIR/hotspots/zero-percent-children.perf.data"
expect_failure_contains "simpleperf report for children emitted no usable sample rows" \
  env OPENCLAW_FAKE_CHILDREN_MODE=zero ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 --out "$zero_percent_children_perf_data"
if [[ -e "$zero_percent_children_perf_data" ]]; then
  fail "zero-percent children report published unvalidated perf data"
fi
missing_binary_cache_perf_data="$TMP_DIR/hotspots/missing-binary-cache.perf.data"
expect_failure_contains "simpleperf capture did not produce the binary cache required for symbolized reports" \
  env OPENCLAW_FAKE_SKIP_BINARY_CACHE=1 ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 --out "$missing_binary_cache_perf_data"
if [[ -e "$missing_binary_cache_perf_data" ]]; then
  fail "hotspots capture without a binary cache published unsymbolized perf data"
fi
empty_binary_cache_perf_data="$TMP_DIR/hotspots/empty-binary-cache.perf.data"
expect_failure_contains "simpleperf capture produced an empty binary cache" \
  env OPENCLAW_FAKE_EMPTY_BINARY_CACHE=1 ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 --out "$empty_binary_cache_perf_data"
if [[ -e "$empty_binary_cache_perf_data" ]]; then
  fail "hotspots capture with an empty binary cache published unsymbolized perf data"
fi
stale_existing_perf_data="$TMP_DIR/hotspots/stale-existing.perf.data"
printf 'stale perf data\n' >"$stale_existing_perf_data"
expect_failure_contains "simpleperf capture did not produce non-empty perf data" \
  env OPENCLAW_FAKE_SKIP_PERF_OUTPUT=1 ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 --out "$stale_existing_perf_data"
if [[ "$(cat "$stale_existing_perf_data")" != "stale perf data" ]]; then
  fail "failed hotspots capture did not restore the prior regular output"
fi
expect_failure_contains "simpleperf capture did not produce non-empty perf data" \
  env OPENCLAW_FAKE_SKIP_PERF_OUTPUT=1 ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 --out "$TMP_DIR/hotspots/missing.perf.data"
partial_failed_perf_data="$TMP_DIR/hotspots/partial-failure.perf.data"
partial_failed_perf_harden_state="$TMP_DIR/hotspots/partial-failure-perf-harden-state"
printf '\n' >"$partial_failed_perf_harden_state"
expect_failure_contains "simpleperf capture failed" \
  env OPENCLAW_FAKE_LEGACY_PERF_HARDEN_STATE="$partial_failed_perf_harden_state" \
  OPENCLAW_FAKE_PARTIAL_CAPTURE_FAIL=1 ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 --out "$partial_failed_perf_data"
if [[ -e "$partial_failed_perf_data" ]]; then
  fail "failed hotspots capture left partial perf data at a new output path"
fi
if [[ -n "$(cat "$partial_failed_perf_harden_state")" ]]; then
  fail "failed legacy hotspots capture did not restore an originally empty security.perf_harden"
fi
publish_race_perf_data="$TMP_DIR/hotspots/publish-race.perf.data"
expect_failure_contains "Failed to atomically publish perf data" \
  env OPENCLAW_FAKE_PUBLISH_RACE_OUTPUT="$publish_race_perf_data" \
  ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 --out "$publish_race_perf_data"
if [[ ! -d "$publish_race_perf_data" ]]; then
  fail "hotspots publish race did not leave the injected destination directory intact"
fi
if [[ -e "$publish_race_perf_data/capture.perf.data" ]]; then
  fail "hotspots publish race moved perf data into a destination directory"
fi
publish_file_race_perf_data="$TMP_DIR/hotspots/publish-file-race.perf.data"
expect_failure_contains "Failed to atomically publish perf data" \
  env OPENCLAW_FAKE_PUBLISH_RACE_FILE="$publish_file_race_perf_data" \
  ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 --out "$publish_file_race_perf_data"
if [[ "$(cat "$publish_file_race_perf_data")" != "competing perf data" ]]; then
  fail "hotspots publish race replaced a regular destination that appeared during capture"
fi
publish_existing_file_race_perf_data="$TMP_DIR/hotspots/publish-existing-file-race.perf.data"
printf 'original perf data\n' >"$publish_existing_file_race_perf_data"
expect_failure_contains "Failed to atomically publish perf data" \
  env OPENCLAW_FAKE_PUBLISH_RACE_FILE="$publish_existing_file_race_perf_data" \
  ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 --out "$publish_existing_file_race_perf_data"
if [[ "$(cat "$publish_existing_file_race_perf_data")" != "competing perf data" ]]; then
  fail "hotspots publish race overwrote a competing update to a pre-existing destination"
fi
publish_replaced_existing_perf_data="$TMP_DIR/hotspots/publish-replaced-existing.perf.data"
printf 'original perf data\n' >"$publish_replaced_existing_perf_data"
expect_failure_contains "--out changed during capture; refusing to replace it" \
  env OPENCLAW_FAKE_REPLACE_PREEXISTING_OUTPUT="$publish_replaced_existing_perf_data" \
  ANDROID_GRADLEW="$TMP_DIR/gradlew" ANDROID_SDK_ROOT="$fake_sdk" \
  "$ANDROID_DIR/scripts/perf-startup-hotspots.sh" --serial wanted --duration 1 --out "$publish_replaced_existing_perf_data"
if [[ "$(cat "$publish_replaced_existing_perf_data")" != "competing replacement perf data" ]]; then
  fail "hotspots publish race overwrote a pre-existing destination replaced during capture"
fi

echo "android shell tool smoke tests passed"
