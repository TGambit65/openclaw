#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=./android-common.sh
source "$SCRIPT_DIR/android-common.sh"
configure_android_sdk_env "$ANDROID_DIR"

RESULTS_DIR="$ANDROID_DIR/benchmark/results"
if [[ -n "${ANDROID_BENCHMARK_RESULTS_DIR:-}" ]]; then
  RESULTS_DIR="$(make_path_absolute "$ANDROID_BENCHMARK_RESULTS_DIR")"
fi
BENCHMARK_OUTPUTS_DIR="$ANDROID_DIR/benchmark/build/outputs"
if [[ -n "${ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR:-}" ]]; then
  BENCHMARK_OUTPUTS_DIR="$(make_path_absolute "$ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR")"
fi
CLASS_FILTER="ai.openclaw.android.benchmark.StartupMacrobenchmark#coldStartup"
EXPECTED_RUNS=10
BASELINE_JSON=""
BASELINE_MEDIAN=""
BASELINE_COMPARE_JSON=""
BASELINE_SNAPSHOT_DIR=""
DEVICE_SERIAL="${ANDROID_SERIAL:-}"
GRADLEW="./gradlew"
run_log=""
pre_run_outputs=""
new_benchmark_outputs=""
snapshot_tmp=""
baseline_candidates=""
if [[ -n "${ANDROID_GRADLEW:-}" ]]; then
  GRADLEW="$(make_path_absolute "$ANDROID_GRADLEW")"
fi

usage() {
  cat <<'EOF'
Usage:
  ./scripts/perf-startup-benchmark.sh [--baseline <benchmarkData.json>] [--serial <adb-serial>]

Runs cold-start macrobenchmark only, then prints a compact summary.
Also saves a timestamped snapshot JSON under benchmark/results/.
If --baseline is omitted, compares against the latest compatible previous snapshot when available.
EOF
}

file_mtime_sort_key() {
  local path="$1"
  local value=""
  # GNU stat's high-resolution %y output includes local wall-clock time. Force
  # UTC so lexicographic ordering remains chronological across DST fall-back.
  if value="$(TZ=UTC0 stat -c '%y' "$path" 2>/dev/null)"; then
    :
  elif value="$(stat -f '%.9Fm' "$path")"; then
    :
  else
    return 1
  fi
  if [[ -z "$value" ]]; then
    return 1
  fi
  printf '%s\n' "$value"
}

file_state_key() {
  local path="$1"
  local checksum=""
  local metadata_before=""
  local metadata_after=""
  # Whole-second mtimes plus content checksums can't distinguish a fresh
  # byte-identical rewrite. Include high-resolution mtime/ctime and inode data
  # so a completed Gradle run isn't rejected merely because values repeated.
  if ! metadata_before="$(stat -c '%y:%z:%i:%s' "$path" 2>/dev/null)"; then
    if ! metadata_before="$(stat -f '%.9Fm:%.9Fc:%i:%z' "$path")"; then
      return 1
    fi
  fi
  if ! checksum="$(cksum <"$path" | awk '{printf "%s:%s", $1, $2}')"; then
    return 1
  fi
  if ! metadata_after="$(stat -c '%y:%z:%i:%s' "$path" 2>/dev/null)"; then
    if ! metadata_after="$(stat -f '%.9Fm:%.9Fc:%i:%z' "$path")"; then
      return 1
    fi
  fi
  if [[ -z "$metadata_before" || -z "$checksum" || "$metadata_before" != "$metadata_after" ]]; then
    echo "File changed while its state was being inspected: $path" >&2
    return 1
  fi
  printf '%s:%s\n' "$metadata_after" "$checksum"
}

publish_benchmark_snapshot() {
  local source_path="$1"
  local destination_path="$2"
  local publish_error=""
  local source_checksum=""
  local destination_checksum=""

  if [[ -e "$destination_path" || -L "$destination_path" ]]; then
    echo "Benchmark snapshot destination appeared during publication; refusing to overwrite it: $destination_path" >&2
    return 1
  fi
  if ! source_checksum="$(cksum <"$source_path" | awk '{printf "%s:%s", $1, $2}')"; then
    echo "Failed to checksum validated benchmark snapshot before publication: $source_path" >&2
    return 1
  fi

  # Link the validated file into place with the no-replace link(2) primitive.
  # Unlike `mv source destination`, link(2) never treats a destination directory
  # as a container, and it atomically rejects every pre-existing destination.
  if ! publish_error="$(
    node - "$source_path" "$destination_path" 2>&1 <<'NODE'
const fs = require("node:fs");

const [sourcePath, destinationPath] = process.argv.slice(2);
try {
  fs.linkSync(sourcePath, destinationPath);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
NODE
  )"; then
    if [[ -e "$destination_path" || -L "$destination_path" ]]; then
      echo "Benchmark snapshot destination appeared during publication; refusing to overwrite it: $destination_path" >&2
    else
      echo "Failed to publish validated benchmark snapshot: $destination_path" >&2
    fi
    if [[ -n "$publish_error" ]]; then
      printf '%s\n' "$publish_error" >&2
    fi
    return 1
  fi
  if [[ ! -f "$destination_path" || -L "$destination_path" ]]; then
    echo "Benchmark snapshot publication did not produce a regular file: $destination_path" >&2
    return 1
  fi
  if ! destination_checksum="$(cksum <"$destination_path" | awk '{printf "%s:%s", $1, $2}')"; then
    echo "Failed to checksum published benchmark snapshot: $destination_path" >&2
    return 1
  fi
  if [[ -z "$source_checksum" || "$destination_checksum" != "$source_checksum" ]]; then
    echo "Published benchmark snapshot does not match the validated source: $destination_path" >&2
    return 1
  fi
  if ! rm -f -- "$source_path"; then
    echo "Published benchmark snapshot but failed to remove its temporary source: $source_path" >&2
    return 1
  fi
}

snapshot_benchmark_outputs() {
  local outputs_dir="$1"
  local file=""
  local state=""
  if [[ ! -d "$outputs_dir" ]]; then
    return 0
  fi
  find -H "$outputs_dir" -name '*benchmarkData.json' -type f -print0 \
    | while IFS= read -r -d '' file; do
        if ! state="$(file_state_key "$file")"; then
          echo "Failed to inspect existing benchmark output: $file" >&2
          exit 1
        fi
        printf '%s\0%s\0' "$file" "$state"
      done
}

previous_file_state_or_empty() {
  local manifest="$1"
  local path="$2"
  local recorded_path=""
  local recorded_state=""

  while IFS= read -r -d '' recorded_path; do
    if ! IFS= read -r -d '' recorded_state; then
      echo "Corrupt benchmark output manifest: $manifest" >&2
      return 1
    fi
    if [[ "$recorded_path" == "$path" ]]; then
      printf '%s\n' "$recorded_state"
      return 0
    fi
  done <"$manifest"
}

jq_required() {
  local query="$1"
  local file="$2"
  local description="$3"
  local value=""
  if ! value="$(jq -er "$query" "$file" 2>/dev/null)"; then
    echo "Missing or invalid $description in $file" >&2
    exit 1
  fi
  if [[ "$value" == *$'\n'* ]]; then
    echo "Expected exactly one $description in $file, found multiple." >&2
    exit 1
  fi
  printf '%s\n' "$value"
}

jq_required_number() {
  local query="$1"
  local file="$2"
  local description="$3"
  jq_required "($query) | numbers" "$file" "numeric $description"
}

jq_required_positive_number() {
  local query="$1"
  local file="$2"
  local description="$3"
  jq_required "($query) | numbers | select(. > 0)" "$file" "numeric $description"
}

jq_required_positive_integer() {
  local query="$1"
  local file="$2"
  local description="$3"
  jq_required "($query) | numbers | select(. > 0 and floor == .)" "$file" "positive integer $description"
}

jq_required_nonempty_string() {
  local query="$1"
  local file="$2"
  local description="$3"
  jq_required "($query) | strings | select(length > 0)" "$file" "non-empty string $description"
}

require_single_cold_startup_benchmark() {
  local file="$1"
  jq_required_number '
    [.benchmarks[]? | select(.name == "coldStartup")]
    | length
    | select(. == 1)
  ' "$file" 'coldStartup benchmark entry count' >/dev/null
}

benchmark_context_key_or_empty() {
  local file="$1"
  jq -r '[
    (.context.build.brand | strings | select(length > 0)),
    (.context.build.model | strings | select(length > 0)),
    (.context.build.version.sdk | numbers | tostring),
    (.context.build.fingerprint | strings | select(length > 0))
  ] | select(length == 4) | @tsv' "$file" 2>/dev/null || true
}

benchmark_cov_or_empty() {
  local file="$1"
  local cov=""
  if ! cov="$(jq_required '
    (.benchmarks[] | select(.name=="coldStartup") | .metrics.timeToInitialDisplayMs)
    | objects
    | if has("coefficientOfVariation") then
        (.coefficientOfVariation | numbers | select(. >= 0))
      else
        ""
      end
  ' "$file" 'non-negative numeric coldStartup coefficientOfVariation')"; then
    return 1
  fi
  if [[ -n "$cov" ]]; then
    printf '%s\n' "$cov"
  fi
}

validated_baseline_median() {
  local file="$1"
  local median=""
  local runs_count=""
  local runs_median=""

  require_single_cold_startup_benchmark "$file"
  median="$(jq_required_positive_number '.benchmarks[] | select(.name=="coldStartup") | .metrics.timeToInitialDisplayMs.median' "$file" 'baseline coldStartup median')"
  runs_count="$(jq_required_number '
    (.benchmarks[] | select(.name=="coldStartup") | .metrics.timeToInitialDisplayMs.runs)
    | arrays
    | select(length > 0)
    | select(all(.[]; type == "number" and . > 0))
    | length
  ' "$file" 'baseline coldStartup run count')"
  if [[ "$runs_count" -ne "$EXPECTED_RUNS" ]]; then
    echo "Unexpected baseline coldStartup run count: expected $EXPECTED_RUNS, got $runs_count in $file" >&2
    exit 1
  fi
  runs_median="$(jq_required_positive_number '
    (.benchmarks[] | select(.name=="coldStartup") | .metrics.timeToInitialDisplayMs.runs)
    | arrays
    | select(length > 0)
    | select(all(.[]; type == "number" and . > 0))
    | sort as $sorted
    | ((($sorted | length) - 1) / 2) as $index
    | ($index | floor) as $lower
    | ($index | ceil) as $upper
    | ($index - $lower) as $ratio
    | ($sorted[$lower] * (1 - $ratio)) + ($sorted[$upper] * $ratio)
  ' "$file" 'baseline coldStartup median derived from runs')"
  if ! awk -v reported="$median" -v derived="$runs_median" '
    function abs(value) { return value < 0 ? -value : value }
    BEGIN {
      scale = abs(derived) > 1 ? abs(derived) : 1
      exit abs(reported - derived) <= (scale * 1e-9) ? 0 : 1
    }
  '; then
    echo "Inconsistent baseline coldStartup summary: reported median does not match runs in $file; reported median=$median runs median=$runs_median" >&2
    exit 1
  fi

  printf '%s\n' "$median"
}

metric_label() {
  local value="$1"
  printf '%s' "$value" | tr -c '[:alnum:].-' '_'
}

cleanup_benchmark() {
  local exit_status=$?
  rm -f -- "${run_log:-}" "${pre_run_outputs:-}" "${new_benchmark_outputs:-}" "${snapshot_tmp:-}" "${baseline_candidates:-}"
  if [[ -n "${BASELINE_SNAPSHOT_DIR:-}" ]]; then
    rm -rf -- "$BASELINE_SNAPSHOT_DIR"
  fi
  return "$exit_status"
}

trap cleanup_benchmark EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      break
      ;;
    --baseline)
      require_arg_value "$1" "${2-}" usage
      BASELINE_JSON="$(make_path_absolute "$2")"
      shift 2
      ;;
    --serial)
      require_arg_value "$1" "${2-}" usage
      DEVICE_SERIAL="$2"
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

if [[ -n "$BASELINE_JSON" && ! -f "$BASELINE_JSON" ]]; then
  echo "Baseline file missing: $BASELINE_JSON" >&2
  exit 1
fi

if [[ -e "$RESULTS_DIR" && ! -d "$RESULTS_DIR" ]]; then
  echo "ANDROID_BENCHMARK_RESULTS_DIR must be a directory path, got: $RESULTS_DIR" >&2
  exit 2
fi
if [[ -e "$BENCHMARK_OUTPUTS_DIR" && ! -d "$BENCHMARK_OUTPUTS_DIR" ]]; then
  echo "ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR must be a directory path, got: $BENCHMARK_OUTPUTS_DIR" >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq required but missing." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node required but missing." >&2
  exit 1
fi

if [[ -n "$BASELINE_JSON" ]]; then
  BASELINE_SNAPSHOT_DIR="$(make_temp_dir openclaw-android-benchmark-baseline)"
  BASELINE_COMPARE_JSON="$BASELINE_SNAPSHOT_DIR/$(basename -- "$BASELINE_JSON")"
  if ! baseline_state_before="$(file_state_key "$BASELINE_JSON")"; then
    echo "Failed to inspect explicit benchmark baseline before it was copied: $BASELINE_JSON" >&2
    exit 1
  fi
  if ! cp -- "$BASELINE_JSON" "$BASELINE_COMPARE_JSON"; then
    echo "Failed to snapshot baseline file for a stable comparison: $BASELINE_JSON" >&2
    exit 1
  fi
  if ! baseline_state_after="$(file_state_key "$BASELINE_JSON")"; then
    echo "Explicit benchmark baseline disappeared while it was being copied: $BASELINE_JSON" >&2
    exit 1
  fi
  if [[ "$baseline_state_before" != "$baseline_state_after" ]] \
    || ! cmp -s "$BASELINE_JSON" "$BASELINE_COMPARE_JSON"; then
    echo "Explicit benchmark baseline changed while it was being copied: $BASELINE_JSON" >&2
    exit 1
  fi
  BASELINE_MEDIAN="$(validated_baseline_median "$BASELINE_COMPARE_JSON")"
fi

if ! command -v adb >/dev/null 2>&1; then
  echo "adb required but missing." >&2
  exit 1
fi

DEVICE_SERIAL="$(resolve_android_serial "$DEVICE_SERIAL")"
export ANDROID_SERIAL="$DEVICE_SERIAL"

mkdir -p "$RESULTS_DIR"
timestamp="$(date +%Y%m%d-%H%M%S)"
snapshot_tmp="$(TMPDIR="$RESULTS_DIR" make_temp_file_with_suffix "startup-$timestamp" .json.tmp)"

run_log="$(make_temp_file_with_suffix openclaw-android-bench .log)"
pre_run_outputs="$(make_temp_file openclaw-android-bench-before)"
new_benchmark_outputs="$(make_temp_file openclaw-android-bench-new)"
if [[ -z "$BASELINE_JSON" ]]; then
  baseline_candidates="$(make_temp_file openclaw-android-bench-baselines)"
  BASELINE_SNAPSHOT_DIR="$(make_temp_dir openclaw-android-benchmark-baselines)"
  candidate_index=0
  # TMPDIR can legitimately point at the results directory. In that case the
  # stable baseline-copy directory lives below the tree being scanned. Prune
  # our reserved scratch namespace so find can't rediscover copies created by
  # this same pipeline and recurse indefinitely.
  if ! find -H "$RESULTS_DIR" \
    -name 'openclaw-android-benchmark-baselines.*' -prune -o \
    -name 'startup-*.json' -type f -print0 \
    | while IFS= read -r -d '' file; do
        candidate_state_before=""
        candidate_state_after=""
        candidate_mtime_key=""
        candidate_index=$((candidate_index + 1))
        candidate_snapshot_dir="$BASELINE_SNAPSHOT_DIR/$candidate_index"
        candidate_compare_json="$candidate_snapshot_dir/$(basename -- "$file")"

        if ! candidate_state_before="$(file_state_key "$file")"; then
          echo "Failed to inspect local benchmark snapshot before the macrobenchmark run: $file" >&2
          exit 1
        fi
        if ! candidate_mtime_key="$(file_mtime_sort_key "$file")"; then
          echo "Failed to inspect local benchmark snapshot timestamp: $file" >&2
          exit 1
        fi
        if ! mkdir -p "$candidate_snapshot_dir"; then
          echo "Failed to prepare a stable local benchmark snapshot copy: $file" >&2
          exit 1
        fi
        if ! cp -- "$file" "$candidate_compare_json"; then
          echo "Failed to copy local benchmark snapshot for a stable comparison: $file" >&2
          exit 1
        fi
        if ! candidate_state_after="$(file_state_key "$file")"; then
          echo "Local benchmark snapshot disappeared while it was being copied: $file" >&2
          exit 1
        fi
        if [[ "$candidate_state_before" != "$candidate_state_after" ]]; then
          echo "Local benchmark snapshot changed while it was being copied: $file" >&2
          exit 1
        fi
        if ! cmp -s "$file" "$candidate_compare_json"; then
          echo "Stable local benchmark snapshot copy does not match source: $file" >&2
          exit 1
        fi
        printf '%s\0%s\0%s\0' "$file" "$candidate_compare_json" "$candidate_mtime_key"
      done \
    >"$baseline_candidates"; then
    echo "Failed to snapshot local benchmark baselines before the macrobenchmark run: $RESULTS_DIR" >&2
    exit 1
  fi
fi

cd "$ANDROID_DIR"
require_android_sdk_env "$ANDROID_DIR"
require_executable_file "Gradle wrapper" "$GRADLEW"
if ! snapshot_benchmark_outputs "$BENCHMARK_OUTPUTS_DIR" >"$pre_run_outputs"; then
  echo "Failed to scan benchmark outputs before the macrobenchmark run: $BENCHMARK_OUTPUTS_DIR" >&2
  exit 1
fi

if ! ANDROID_SERIAL="$DEVICE_SERIAL" "$GRADLEW" :benchmark:connectedDebugAndroidTest \
  -Pandroid.injected.device.serial="$DEVICE_SERIAL" \
  -Pandroid.testInstrumentationRunnerArguments.class="$CLASS_FILTER" \
  --console=plain \
  >"$run_log" 2>&1; then
  echo "Macrobenchmark run failed. tail(run_log):" >&2
  tail -n 120 "$run_log" >&2
  exit 1
fi

if [[ -d "$BENCHMARK_OUTPUTS_DIR" ]]; then
  if ! find -H "$BENCHMARK_OUTPUTS_DIR" \
    -name '*benchmarkData.json' -type f -print0 \
    | while IFS= read -r -d '' file; do
        current_state=""
        previous_state=""
        if ! current_state="$(file_state_key "$file")"; then
          echo "Failed to inspect benchmark output produced by this run: $file" >&2
          exit 1
        fi
        if ! previous_state="$(previous_file_state_or_empty "$pre_run_outputs" "$file")"; then
          echo "Failed to compare benchmark output with the pre-run manifest: $file" >&2
          exit 1
        fi
        if [[ -n "$previous_state" && "$current_state" == "$previous_state" ]]; then
          continue
        fi
        printf '%s\0%s\0' "$file" "$current_state"
      done \
    >"$new_benchmark_outputs"; then
    echo "Failed to scan benchmark outputs after the macrobenchmark run: $BENCHMARK_OUTPUTS_DIR" >&2
    exit 1
  fi
fi

new_benchmark_output_count=0
latest_json=""
latest_json_state=""
while IFS= read -r -d '' file; do
  if ! IFS= read -r -d '' current_state; then
    echo "Corrupt post-run benchmark output manifest: $new_benchmark_outputs" >&2
    exit 1
  fi
  new_benchmark_output_count=$((new_benchmark_output_count + 1))
  if [[ "$new_benchmark_output_count" -eq 1 ]]; then
    latest_json="$file"
    latest_json_state="$current_state"
  fi
done <"$new_benchmark_outputs"
if [[ "$new_benchmark_output_count" -eq 0 ]]; then
  echo "No new benchmarkData.json was produced by this run (stale build outputs ignored)." >&2
  tail -n 120 "$run_log" >&2
  exit 1
fi
if [[ "$new_benchmark_output_count" -ne 1 ]]; then
  echo "Expected exactly one new benchmarkData.json from this run, found $new_benchmark_output_count:" >&2
  while IFS= read -r -d '' file; do
    if ! IFS= read -r -d '' current_state; then
      echo "Corrupt post-run benchmark output manifest: $new_benchmark_outputs" >&2
      exit 1
    fi
    printf '  %s\n' "$file" >&2
  done <"$new_benchmark_outputs"
  exit 1
fi

if [[ ! -f "$latest_json" ]]; then
  echo "New benchmarkData.json disappeared before it could be validated: $latest_json" >&2
  exit 1
fi

if ! current_state="$(file_state_key "$latest_json")"; then
  echo "New benchmarkData.json disappeared or became unreadable before it could be copied: $latest_json" >&2
  exit 1
fi
if [[ "$current_state" != "$latest_json_state" ]]; then
  echo "New benchmarkData.json changed after discovery and before it could be copied: $latest_json" >&2
  exit 1
fi
if ! cp -- "$latest_json" "$snapshot_tmp"; then
  echo "Failed to copy new benchmarkData.json for stable validation: $latest_json" >&2
  exit 1
fi
if ! current_state="$(file_state_key "$latest_json")"; then
  echo "New benchmarkData.json disappeared or became unreadable while it was being copied: $latest_json" >&2
  exit 1
fi
if [[ "$current_state" != "$latest_json_state" ]]; then
  echo "New benchmarkData.json changed while it was being copied: $latest_json" >&2
  exit 1
fi
if ! cmp -s "$latest_json" "$snapshot_tmp"; then
  echo "Stable benchmarkData.json copy does not match the Gradle output: $latest_json" >&2
  exit 1
fi
latest_json="$snapshot_tmp"

require_single_cold_startup_benchmark "$latest_json"
median_ms="$(jq_required_positive_number '.benchmarks[] | select(.name=="coldStartup") | .metrics.timeToInitialDisplayMs.median' "$latest_json" 'coldStartup median')"
min_ms="$(jq_required_positive_number '.benchmarks[] | select(.name=="coldStartup") | .metrics.timeToInitialDisplayMs.minimum' "$latest_json" 'coldStartup minimum')"
max_ms="$(jq_required_positive_number '.benchmarks[] | select(.name=="coldStartup") | .metrics.timeToInitialDisplayMs.maximum' "$latest_json" 'coldStartup maximum')"
if ! awk -v minimum="$min_ms" -v median="$median_ms" -v maximum="$max_ms" \
  'BEGIN { exit (minimum <= median && median <= maximum) ? 0 : 1 }'; then
  echo "Inconsistent coldStartup summary: expected minimum <= median <= maximum in $latest_json; got minimum=$min_ms median=$median_ms maximum=$max_ms" >&2
  exit 1
fi
runs_count="$(jq_required_number '
  (.benchmarks[] | select(.name=="coldStartup") | .metrics.timeToInitialDisplayMs.runs)
  | arrays
  | select(length > 0)
  | select(all(.[]; type == "number" and . > 0))
  | length
' "$latest_json" 'coldStartup run count')"
if [[ "$runs_count" -ne "$EXPECTED_RUNS" ]]; then
  echo "Unexpected coldStartup run count: expected $EXPECTED_RUNS, got $runs_count in $latest_json" >&2
  exit 1
fi
runs_min_ms="$(jq_required_positive_number '
  (.benchmarks[] | select(.name=="coldStartup") | .metrics.timeToInitialDisplayMs.runs)
  | arrays
  | select(length > 0)
  | select(all(.[]; type == "number" and . > 0))
  | min
' "$latest_json" 'coldStartup minimum derived from runs')"
runs_max_ms="$(jq_required_positive_number '
  (.benchmarks[] | select(.name=="coldStartup") | .metrics.timeToInitialDisplayMs.runs)
  | arrays
  | select(length > 0)
  | select(all(.[]; type == "number" and . > 0))
  | max
' "$latest_json" 'coldStartup maximum derived from runs')"
runs_median_ms="$(jq_required_positive_number '
  (.benchmarks[] | select(.name=="coldStartup") | .metrics.timeToInitialDisplayMs.runs)
  | arrays
  | select(length > 0)
  | select(all(.[]; type == "number" and . > 0))
  | sort as $sorted
  | ((($sorted | length) - 1) / 2) as $index
  | ($index | floor) as $lower
  | ($index | ceil) as $upper
  | ($index - $lower) as $ratio
  | ($sorted[$lower] * (1 - $ratio)) + ($sorted[$upper] * $ratio)
' "$latest_json" 'coldStartup median derived from runs')"
if ! awk -v minimum="$min_ms" -v maximum="$max_ms" -v runs_minimum="$runs_min_ms" -v runs_maximum="$runs_max_ms" \
  'BEGIN { exit (minimum == runs_minimum && maximum == runs_maximum) ? 0 : 1 }'; then
  echo "Inconsistent coldStartup summary: reported minimum/maximum do not match runs in $latest_json; reported minimum=$min_ms maximum=$max_ms, runs minimum=$runs_min_ms maximum=$runs_max_ms" >&2
  exit 1
fi
if ! awk -v reported="$median_ms" -v derived="$runs_median_ms" '
  function abs(value) { return value < 0 ? -value : value }
  BEGIN {
    scale = abs(derived) > 1 ? abs(derived) : 1
    exit abs(reported - derived) <= (scale * 1e-9) ? 0 : 1
  }
'; then
  echo "Inconsistent coldStartup summary: reported median does not match runs in $latest_json; reported median=$median_ms runs median=$runs_median_ms" >&2
  exit 1
fi
# AndroidX 1.4+ serializes coefficientOfVariation. Recompute it from the raw
# runs so a malformed summary can't make a noisy benchmark look stable. Older
# artifacts without the serialized field use the recomputed value directly.
runs_cov="$(jq_required_number '
  (.benchmarks[] | select(.name=="coldStartup") | .metrics.timeToInitialDisplayMs.runs)
  | arrays
  | select(length > 0)
  | select(all(.[]; type == "number" and . > 0))
  | . as $runs
  | ($runs | add / length) as $mean
  | if length == 1 then
      0
    else
      (((map(. - $mean | . * .) | add) / (length - 1) | sqrt) / $mean)
    end
' "$latest_json" 'coldStartup coefficientOfVariation computed from runs')"
if ! reported_cov="$(benchmark_cov_or_empty "$latest_json")"; then
  exit 1
fi
if [[ -z "$reported_cov" ]]; then
  cov="$runs_cov"
else
  if ! awk -v reported="$reported_cov" -v derived="$runs_cov" '
    function abs(value) { return value < 0 ? -value : value }
    BEGIN {
      scale = abs(derived) > 1 ? abs(derived) : 1
      exit abs(reported - derived) <= (scale * 1e-6) ? 0 : 1
    }
  '; then
    echo "Inconsistent coldStartup summary: reported coefficientOfVariation does not match runs in $latest_json; reported coefficientOfVariation=$reported_cov runs coefficientOfVariation=$runs_cov" >&2
    exit 1
  fi
  cov="$reported_cov"
fi
brand="$(jq_required_nonempty_string '.context.build.brand' "$latest_json" 'device brand')"
device="$(jq_required_nonempty_string '.context.build.model' "$latest_json" 'device model')"
sdk="$(jq_required_positive_integer '.context.build.version.sdk' "$latest_json" 'device sdk version')"
jq_required_nonempty_string '.context.build.fingerprint' "$latest_json" 'device fingerprint' >/dev/null
current_context_key="$(benchmark_context_key_or_empty "$latest_json")"
current_context_label="$(metric_label "${brand}_${device}_sdk${sdk}")"

snapshot_json="${snapshot_tmp%.tmp}"
publish_benchmark_snapshot "$snapshot_tmp" "$snapshot_json"
snapshot_tmp=""

echo "device_serial=$DEVICE_SERIAL"
echo "device_context=$current_context_label"
printf 'startup.cold.median_ms=%.3f min_ms=%.3f max_ms=%.3f cov=%.4f runs=%s device=%s sdk=%s\n' \
  "$median_ms" "$min_ms" "$max_ms" "$cov" "$runs_count" "$device" "$sdk"
echo "snapshot_json=$snapshot_json"

baseline_auto_selected=0
if [[ -z "$BASELINE_JSON" ]]; then
  latest_baseline_mtime_key=""
  file_mtime_key=""
  while IFS= read -r -d '' file; do
    if ! IFS= read -r -d '' candidate_compare_json \
      || ! IFS= read -r -d '' file_mtime_key; then
      echo "Corrupt local benchmark baseline manifest: $baseline_candidates" >&2
      exit 1
    fi
    context_key=""
    median_value=""
    context_key="$(benchmark_context_key_or_empty "$candidate_compare_json")"
    if [[ -z "$context_key" || "$context_key" != "$current_context_key" ]]; then
      continue
    fi
    # Local snapshots are optional inputs. Ignore malformed implicit
    # candidates instead of letting one abort a successful current run after
    # its snapshot has already been published. Explicit --baseline inputs
    # remain fail-closed through the same validator.
    if ! median_value="$(validated_baseline_median "$candidate_compare_json" 2>/dev/null)"; then
      continue
    fi
    if [[ -z "$BASELINE_JSON" ]] \
      || [[ "$file_mtime_key" > "$latest_baseline_mtime_key" ]] \
      || { [[ "$file_mtime_key" == "$latest_baseline_mtime_key" ]] && [[ "$file" > "$BASELINE_JSON" ]]; }; then
      BASELINE_JSON="$file"
      BASELINE_COMPARE_JSON="$candidate_compare_json"
      BASELINE_MEDIAN="$median_value"
      latest_baseline_mtime_key="$file_mtime_key"
    fi
  done <"$baseline_candidates"
  rm -f -- "$baseline_candidates"
  baseline_candidates=""
  baseline_auto_selected=1
fi

if [[ -n "$BASELINE_JSON" ]]; then
  baseline_read_json="$BASELINE_JSON"
  if [[ -n "$BASELINE_COMPARE_JSON" ]]; then
    baseline_read_json="$BASELINE_COMPARE_JSON"
  elif [[ ! -f "$BASELINE_JSON" ]]; then
    echo "Baseline file missing: $BASELINE_JSON" >&2
    exit 1
  fi
  baseline_context_key="$(benchmark_context_key_or_empty "$baseline_read_json")"
  if [[ -z "$baseline_context_key" ]]; then
    echo "Warning: baseline device context is missing or invalid; comparing by explicit request." >&2
  elif [[ "$baseline_context_key" != "$current_context_key" ]]; then
    echo "Warning: baseline device context differs from current run (${brand} ${device} sdk=${sdk})." >&2
  fi
  echo "baseline_json=$BASELINE_JSON"
  if [[ -n "$BASELINE_MEDIAN" ]]; then
    base_median="$BASELINE_MEDIAN"
  else
    base_median="$(validated_baseline_median "$baseline_read_json")"
  fi
  delta_ms="$(awk -v a="$median_ms" -v b="$base_median" 'BEGIN { printf "%.3f", (a-b) }')"
  delta_pct="$(awk -v a="$median_ms" -v b="$base_median" 'BEGIN { if (b==0) { print "nan" } else { printf "%.2f", ((a-b)/b)*100 } }')"
  echo "baseline_median_ms=$base_median delta_ms=$delta_ms delta_pct=$delta_pct%"
elif [[ "$baseline_auto_selected" -eq 1 ]]; then
  echo "baseline_median_ms=skipped reason=no-compatible-local-snapshot device_context=$current_context_label"
fi
