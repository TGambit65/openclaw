#!/usr/bin/env bash
set -euo pipefail

is_absolute_path() {
  local path="${1-}"
  case "$path" in
    /*|[A-Za-z]:[\\/]*|\\\\*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

make_path_absolute() {
  local path="$1"
  if is_absolute_path "$path"; then
    printf '%s\n' "$path"
  else
    printf '%s/%s\n' "$(pwd -P)" "$path"
  fi
}

require_temp_name_part() {
  local description="$1"
  local value="${2-}"
  if [[ -z "$value" ]]; then
    echo "$description must be non-empty." >&2
    return 2
  fi
  if [[ "$value" == *"/"* ]]; then
    echo "$description must not contain '/': $value" >&2
    return 2
  fi
}

make_temp_file() {
  local prefix="$1"
  local temp_dir="${TMPDIR:-/tmp}"
  require_temp_name_part "Temporary file prefix" "$prefix"
  temp_dir="$(make_path_absolute "$temp_dir")"
  local template="$temp_dir/${prefix}.XXXXXX"
  mktemp "$template"
}

make_temp_file_with_suffix() {
  local prefix="$1"
  local suffix="$2"
  local path=""
  local suffixed_path=""

  require_temp_name_part "Temporary file prefix" "$prefix"
  require_temp_name_part "Temporary file suffix" "$suffix"

  if ! path="$(make_temp_file "$prefix")"; then
    return 1
  fi
  suffixed_path="$path$suffix"
  # Reserve the suffixed destination without a check-then-move race. A
  # clobbering mv here can overwrite a file created by another process after
  # the existence check, especially when TMPDIR is shared.
  if ! (
    umask 077
    set -o noclobber
    : >"$suffixed_path"
  ) 2>/dev/null; then
    rm -f "$path"
    echo "Temporary path already exists: $suffixed_path" >&2
    return 1
  fi
  if ! rm -f "$path"; then
    rm -f "$suffixed_path"
    echo "Failed to release temporary file reservation: $path" >&2
    return 1
  fi
  printf '%s\n' "$suffixed_path"
}

make_temp_dir() {
  local prefix="$1"
  local temp_dir="${TMPDIR:-/tmp}"
  require_temp_name_part "Temporary directory prefix" "$prefix"
  temp_dir="$(make_path_absolute "$temp_dir")"
  local template="$temp_dir/${prefix}.XXXXXX"
  mktemp -d "$template"
}

existing_dir_absolute() {
  local path="$1"
  (cd -- "$path" && pwd -P)
}

sdk_dir_has_adb() {
  local path="${1:-}"
  [[ -n "$path" ]] || return 1
  if [[ -x "$path/platform-tools/adb" ]]; then
    return 0
  fi
  case "$(uname -s 2>/dev/null || true)" in
    CYGWIN*|MINGW*|MSYS*)
      [[ -x "$path/platform-tools/adb.exe" ]]
      ;;
    *)
      return 1
      ;;
  esac
}

resolve_path_against_base() {
  local base_dir="$1"
  local path="$2"
  if is_absolute_path "$path"; then
    printf '%s\n' "$path"
  else
    printf '%s/%s\n' "$base_dir" "$path"
  fi
}

prepend_path_once() {
  local path_entry="${1:-}"
  local current_path="${PATH:-}"
  local entry=""
  local remaining=""
  local has_more=0
  local -a retained_entries=()
  if [[ -z "$path_entry" || ! -d "$path_entry" ]]; then
    return 0
  fi

  if [[ -z "$current_path" ]]; then
    PATH="$path_entry"
    export PATH
    return 0
  fi

  remaining="$current_path"
  while true; do
    if [[ "$remaining" == *:* ]]; then
      entry="${remaining%%:*}"
      remaining="${remaining#*:}"
      has_more=1
    else
      entry="$remaining"
      has_more=0
    fi

    if [[ "$entry" != "$path_entry" ]]; then
      retained_entries+=("$entry")
    fi

    if [[ "$has_more" -eq 0 ]]; then
      break
    fi
  done

  PATH="$path_entry"
  if [[ "${#retained_entries[@]}" -gt 0 ]]; then
    for entry in "${retained_entries[@]}"; do
      PATH="$PATH:$entry"
    done
  fi
  export PATH
}

android_dir_from_local_properties_key() {
  local properties_path="${1:-}"
  local wanted_key="${2:-}"
  if [[ -z "$properties_path" || ! -f "$properties_path" ]]; then
    return 0
  fi
  if [[ -z "$wanted_key" ]]; then
    return 0
  fi

  LC_ALL=C awk -v wanted_key="$wanted_key" '
    function trim(value) {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      return value
    }

    function trim_leading(value) {
      sub(/^[[:space:]]+/, "", value)
      return value
    }

    function hex_digit(char, position) {
      position = index("0123456789abcdef", tolower(char))
      return position ? position - 1 : -1
    }

    function hex4(value, start,   code, digit, i) {
      if (start + 3 > length(value)) {
        return -1
      }
      code = 0
      for (i = start; i < start + 4; i++) {
        digit = hex_digit(substr(value, i, 1))
        if (digit < 0) {
          return -1
        }
        code = (code * 16) + digit
      }
      return code
    }

    function utf8(code) {
      if (code <= 127) {
        return sprintf("%c", code)
      }
      if (code <= 2047) {
        return sprintf("%c%c", 192 + int(code / 64), 128 + (code % 64))
      }
      if (code <= 65535) {
        return sprintf("%c%c%c", 224 + int(code / 4096), 128 + (int(code / 64) % 64), 128 + (code % 64))
      }
      return sprintf("%c%c%c%c", 240 + int(code / 262144), 128 + (int(code / 4096) % 64), 128 + (int(code / 64) % 64), 128 + (code % 64))
    }

    function record_unicode_error(message) {
      if (unicode_error == "") {
        unicode_error = message
      }
    }

    function unescape_property_value(value,   char, code, escaped, i, low, result) {
      result = ""
      for (i = 1; i <= length(value); i++) {
        char = substr(value, i, 1)
        if (char != "\\") {
          result = result char
          continue
        }
        if (i == length(value)) {
          result = result char
          continue
        }

        escaped = substr(value, i + 1, 1)
        if (escaped == "u") {
          code = hex4(value, i + 2)
          if (code < 0) {
            record_unicode_error("Malformed Unicode escape in local.properties.")
            return result
          }
          if (code == 0) {
            record_unicode_error("Unsupported NUL Unicode escape in local.properties.")
            return result
          }
          if (code < 55296 || code > 57343) {
            result = result utf8(code)
            i += 5
            continue
          }
          if (code >= 55296 && code <= 56319 && substr(value, i + 6, 2) == "\\u") {
            low = hex4(value, i + 8)
            if (low >= 56320 && low <= 57343) {
              code = 65536 + ((code - 55296) * 1024) + (low - 56320)
              result = result utf8(code)
              i += 11
              continue
            }
          }
          record_unicode_error("Unsupported unpaired Unicode surrogate escape in local.properties.")
          return result
        }

        if (escaped == "t") {
          result = result "\t"
        } else if (escaped == "n") {
          result = result "\n"
        } else if (escaped == "r") {
          result = result "\r"
        } else if (escaped == "f") {
          result = result "\f"
        } else {
          result = result escaped
        }
        i++
      }
      return result
    }

    function first_unescaped_separator(line,   i, j, char, lookahead, escaped, seen_key_char) {
      escaped = 0
      seen_key_char = 0
      for (i = 1; i <= length(line); i++) {
        char = substr(line, i, 1)
        if (escaped) {
          seen_key_char = 1
          escaped = 0
          continue
        }
        if (char == "\\") {
          escaped = 1
          continue
        }
        if (char ~ /[[:space:]]/) {
          if (seen_key_char) {
            for (j = i + 1; j <= length(line); j++) {
              lookahead = substr(line, j, 1)
              if (lookahead ~ /[[:space:]]/) {
                continue
              }
              if (lookahead == "=" || lookahead == ":") {
                return j
              }
              break
            }
            return i
          }
          continue
        }
        if (char == "=" || char == ":") {
          return i
        }
        seen_key_char = 1
      }
      return 0
    }

    function line_continues(line,   backslashes, i) {
      backslashes = 0
      for (i = length(line); i > 0 && substr(line, i, 1) == "\\"; i--) {
        backslashes++
      }
      return (backslashes % 2) == 1
    }

    function process_logical_line(line,   key, separator, value) {
      separator = first_unescaped_separator(line)
      if (separator) {
        key = trim(substr(line, 1, separator - 1))
        key = unescape_property_value(key)
        if (unicode_error != "") {
          return
        }
        # java.util.Properties ignores separator whitespace but preserves
        # trailing whitespace in values, including valid SDK/NDK path names.
        value = trim_leading(substr(line, separator + 1))
        value = unescape_property_value(value)
      } else {
        # A property key without a separator has an empty value. Preserve that
        # assignment so a later bare sdk.dir/ndk.dir overrides an earlier one.
        key = trim(line)
        key = unescape_property_value(key)
        value = ""
      }

      if (unicode_error != "") {
        return
      }

      if (key != wanted_key) {
        return
      }

      selected_value = value
      found_value = 1
    }

    {
      physical_line = $0
      sub(/\r$/, "", physical_line)

      if (!continuing && physical_line ~ /^[[:space:]]*[#!]/) {
        next
      }

      if (continuing) {
        sub(/^[[:space:]]+/, "", physical_line)
      }
      logical_line = logical_line physical_line

      if (line_continues(logical_line)) {
        logical_line = substr(logical_line, 1, length(logical_line) - 1)
        continuing = 1
        next
      }

      process_logical_line(logical_line)
      logical_line = ""
      continuing = 0
    }

    END {
      if (continuing || logical_line != "") {
        process_logical_line(logical_line)
      }
      if (unicode_error != "") {
        print unicode_error > "/dev/stderr"
        exit 2
      }
      if (found_value) {
        print selected_value
      }
    }
  ' "$properties_path"
}

android_sdk_dir_from_local_properties() {
  android_dir_from_local_properties_key "${1:-}" "sdk.dir"
}

android_ndk_dir_from_local_properties() {
  android_dir_from_local_properties_key "${1:-}" "ndk.dir"
}

configure_android_sdk_env() {
  local android_dir="${1:-}"
  local home_dir="${HOME:-}"
  local sdk_dir=""
  local root_sdk_dir=""
  local home_sdk_dir=""
  local local_sdk_dir=""
  local adb_capable_fallback=""
  local needs_local_sdk=0
  local candidate=""

  if [[ -n "${ANDROID_SDK_ROOT:-}" && -d "${ANDROID_SDK_ROOT:-}" ]]; then
    root_sdk_dir="$(existing_dir_absolute "$ANDROID_SDK_ROOT")"
  fi
  if [[ -n "${ANDROID_HOME:-}" && -d "${ANDROID_HOME:-}" ]]; then
    home_sdk_dir="$(existing_dir_absolute "$ANDROID_HOME")"
  fi

  if [[ -n "$root_sdk_dir" && -n "$home_sdk_dir" && "$root_sdk_dir" != "$home_sdk_dir" ]]; then
    if ! sdk_dir_has_adb "$root_sdk_dir" && sdk_dir_has_adb "$home_sdk_dir"; then
      sdk_dir="$home_sdk_dir"
    else
      sdk_dir="$root_sdk_dir"
    fi
  elif [[ -n "$root_sdk_dir" ]]; then
    sdk_dir="$root_sdk_dir"
  elif [[ -n "$home_sdk_dir" ]]; then
    sdk_dir="$home_sdk_dir"
  fi

  if [[ -z "$sdk_dir" ]]; then
    needs_local_sdk=1
  elif ! sdk_dir_has_adb "$sdk_dir"; then
    needs_local_sdk=1
  fi

  if [[ "$needs_local_sdk" -eq 1 && -n "$android_dir" ]]; then
    candidate="$(android_sdk_dir_from_local_properties "$android_dir/local.properties")"
    if [[ -n "$candidate" ]]; then
      candidate="$(resolve_path_against_base "$android_dir" "$candidate")"
    fi
    if [[ -n "$candidate" && -d "$candidate" ]]; then
      local_sdk_dir="$(existing_dir_absolute "$candidate")"
    fi
    if [[ -z "$sdk_dir" && -n "$local_sdk_dir" ]]; then
      sdk_dir="$local_sdk_dir"
    fi
  fi

  for candidate in "$home_sdk_dir" "$local_sdk_dir"; do
    if [[ -n "$candidate" && "$candidate" != "$sdk_dir" ]] && sdk_dir_has_adb "$candidate"; then
      adb_capable_fallback="$candidate"
      break
    fi
  done

  if [[ -z "$sdk_dir" && -n "$home_dir" ]]; then
    for candidate in "$home_dir/Android/Sdk" "$home_dir/Library/Android/sdk"; do
      if [[ ! -d "$candidate" ]]; then
        continue
      fi
      candidate="$(existing_dir_absolute "$candidate")"
      if [[ -z "$sdk_dir" ]]; then
        sdk_dir="$candidate"
      fi
      if sdk_dir_has_adb "$candidate"; then
        adb_capable_fallback="$candidate"
        break
      fi
    done
  elif [[ -n "$home_dir" && -z "$adb_capable_fallback" ]]; then
    if ! sdk_dir_has_adb "$sdk_dir"; then
      for candidate in "$home_dir/Android/Sdk" "$home_dir/Library/Android/sdk"; do
        if [[ -d "$candidate" ]]; then
          candidate="$(existing_dir_absolute "$candidate")"
          if [[ "$candidate" != "$sdk_dir" ]] && sdk_dir_has_adb "$candidate"; then
            adb_capable_fallback="$candidate"
            break
          fi
        fi
      done
    fi
  fi

  if [[ -n "$sdk_dir" && -n "$adb_capable_fallback" ]]; then
    if ! sdk_dir_has_adb "$sdk_dir"; then
      sdk_dir="$adb_capable_fallback"
    fi
  fi

  if [[ -z "$sdk_dir" ]]; then
    return 0
  fi

  export ANDROID_SDK_ROOT="$sdk_dir"
  export ANDROID_HOME="$sdk_dir"

  prepend_path_once "$sdk_dir/platform-tools"
}

require_android_sdk_env() {
  local android_dir="${1:-}"
  local local_properties_hint=""

  if [[ -n "${ANDROID_SDK_ROOT:-}" && -d "${ANDROID_SDK_ROOT:-}" ]]; then
    return 0
  fi
  if [[ -n "${ANDROID_HOME:-}" && -d "${ANDROID_HOME:-}" ]]; then
    return 0
  fi

  if [[ -n "$android_dir" ]]; then
    local_properties_hint=" or set sdk.dir in $android_dir/local.properties"
  fi

  echo "Android SDK not found. Set ANDROID_SDK_ROOT / ANDROID_HOME${local_properties_hint}, or install the SDK under ~/Android/Sdk or ~/Library/Android/sdk." >&2
  exit 1
}

require_arg_value() {
  local flag="$1"
  local value="${2-}"
  local usage_fn="${3:-}"
  if [[ -z "$value" || "$value" == -* ]]; then
    echo "Missing value for $flag" >&2
    if [[ -n "$usage_fn" ]]; then
      "$usage_fn" >&2
    fi
    exit 2
  fi
}

require_positive_integer() {
  local flag="$1"
  local value="$2"
  local usage_fn="${3:-}"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "$flag must be a positive integer, got: $value" >&2
    if [[ -n "$usage_fn" ]]; then
      "$usage_fn" >&2
    fi
    exit 2
  fi
}

require_executable_file() {
  local description="$1"
  local path="$2"
  if [[ ! -e "$path" ]]; then
    echo "$description not found: $path" >&2
    exit 1
  fi
  if [[ ! -f "$path" || ! -x "$path" ]]; then
    echo "$description is not executable: $path" >&2
    exit 1
  fi
}

is_valid_android_package_name() {
  local value="$1"
  local pattern='^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'
  [[ "$value" =~ $pattern ]]
}

is_valid_android_activity_name() {
  local value="$1"
  local pattern='^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)*$'
  if [[ "$value" == .* ]]; then
    value="${value#.}"
  fi
  [[ "$value" =~ $pattern ]]
}

require_android_package_name() {
  local value="$1"
  if ! is_valid_android_package_name "$value"; then
    echo "Invalid Android package name: $value" >&2
    exit 2
  fi
}

require_android_activity_name() {
  local value="$1"
  if ! is_valid_android_activity_name "$value"; then
    echo "Invalid Android activity name: $value" >&2
    exit 2
  fi
}

is_valid_gradle_task_path() {
  local value="$1"
  local pattern='^:?[A-Za-z0-9_][A-Za-z0-9_-]*(\:[A-Za-z0-9_][A-Za-z0-9_-]*)*$'
  [[ "$value" =~ $pattern ]]
}

require_gradle_task_path() {
  local value="$1"
  if ! is_valid_gradle_task_path "$value"; then
    echo "Invalid Gradle task path: $value" >&2
    exit 2
  fi
}

require_gradle_install_task_path() {
  local value="$1"
  local task_name=""
  require_gradle_task_path "$value"
  task_name="${value##*:}"
  if [[ ! "$task_name" =~ ^install[A-Za-z0-9_-]*$ ]]; then
    echo "Gradle task must be an install task path, got: $value" >&2
    exit 2
  fi
}

normalize_android_activity_name() {
  local value="$1"
  if [[ "$value" == .* || "$value" == *.* ]]; then
    printf '%s\n' "$value"
  else
    printf '.%s\n' "$value"
  fi
}

resolve_android_serial() {
  local requested="${1:-}"
  local adb_output=""
  local line=""
  local serial=""
  local state=""
  local state_detail=""
  local selected=""
  local seen_header=0
  local -a connected_devices=()
  local -a unavailable_devices=()

  if ! adb_output="$(adb devices 2>&1)"; then
    echo "Failed to run 'adb devices'." >&2
    printf '%s\n' "$adb_output" >&2
    return 1
  fi

  while IFS= read -r line; do
    line="${line%$'\r'}"
    if [[ "$line" == "List of devices attached"* ]]; then
      seen_header=1
      continue
    fi
    if [[ "$seen_header" -eq 0 || -z "$line" ]]; then
      continue
    fi

    read -r serial state state_detail <<<"$line"
    if [[ -z "$serial" || -z "$state" ]]; then
      continue
    fi

    if [[ "$state" == "device" ]]; then
      connected_devices+=("$serial")
    else
      if [[ -n "$state_detail" ]]; then
        unavailable_devices+=("$serial ($state $state_detail)")
      else
        unavailable_devices+=("$serial ($state)")
      fi
    fi
  done < <(printf '%s\n' "$adb_output")

  if [[ "$seen_header" -eq 0 ]]; then
    echo "Unexpected 'adb devices' output; could not find device list header." >&2
    printf '%s\n' "$adb_output" >&2
    return 1
  fi

  if [[ "${#connected_devices[@]}" -lt 1 ]]; then
    echo "No connected Android device (adb state=device)." >&2
    if [[ "${#unavailable_devices[@]}" -gt 0 ]]; then
      echo "Other adb targets:" >&2
      printf '  %s\n' "${unavailable_devices[@]}" >&2
    fi
    return 1
  fi

  if [[ -n "$requested" ]]; then
    for serial in "${connected_devices[@]}"; do
      if [[ "$serial" == "$requested" ]]; then
        selected="$serial"
        break
      fi
    done
    if [[ -z "$selected" ]]; then
      echo "Requested device not connected: $requested" >&2
      echo "Connected devices:" >&2
      printf '  %s\n' "${connected_devices[@]}" >&2
      if [[ "${#unavailable_devices[@]}" -gt 0 ]]; then
        echo "Other adb targets:" >&2
        printf '  %s\n' "${unavailable_devices[@]}" >&2
      fi
      return 1
    fi
  elif [[ "${#connected_devices[@]}" -gt 1 ]]; then
    echo "Multiple Android devices connected. Re-run with --serial <adb-serial>." >&2
    printf 'Connected devices:\n' >&2
    printf '  %s\n' "${connected_devices[@]}" >&2
    return 1
  else
    selected="${connected_devices[0]}"
  fi

  printf '%s\n' "$selected"
}
