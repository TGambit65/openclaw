## OpenClaw Android App

Status: **extremely alpha**. The app is actively being rebuilt from the ground up.

### Rebuild Checklist

- [x] New 4-step onboarding flow
- [x] Connect tab with `Setup Code` + `Manual` modes
- [x] Encrypted persistence for gateway setup/auth state
- [x] Chat UI restyled
- [x] Settings UI restyled and de-duplicated (gateway controls moved to Connect)
- [x] QR code scanning in onboarding
- [x] Performance improvements
- [x] Streaming support in chat UI
- [x] Request camera/location and other permissions in onboarding/settings flow
- [x] Push notifications for gateway/chat status updates
- [x] Security hardening (biometric lock, token handling, safer defaults)
- [x] Voice tab full functionality
- [x] Screen tab full functionality
- [ ] Full end-to-end QA and release hardening

## Open in Android Studio

- Open the folder `apps/android`.

## Build / Run

```bash
cd apps/android
./gradlew :app:assembleDebug
./gradlew :app:installDebug
./gradlew :app:testDebugUnitTest
./scripts/gradle-with-android-env.sh :app:testDebugUnitTest
./scripts/install-debug.sh
./scripts/run-debug.sh
```

The helper scripts fail closed on multi-device setups unless you pass `--serial <adb-serial>` (or set `ANDROID_SERIAL`).

## Kotlin Lint + Format

```bash
pnpm android:lint
pnpm android:format
```

Repo-root Android scripts use the same SDK discovery path:

```bash
pnpm android:assemble
pnpm android:lint
pnpm android:test
```

Android shell-tool smoke tests:

```bash
pnpm test:android:shell-tools
```

Android framework/resource lint (separate pass):

```bash
pnpm android:lint:android
```

Direct Gradle tasks:

```bash
cd apps/android
./gradlew :app:ktlintCheck :benchmark:ktlintCheck
./gradlew :app:ktlintFormat :benchmark:ktlintFormat
./gradlew :app:lintDebug
```

The helper scripts and repo-root Android scripts set `ANDROID_SDK_ROOT` / `ANDROID_HOME` from existing env, `local.properties`, or common SDK locations (`~/Library/Android/sdk` on macOS and `~/Android/Sdk` on Linux). Gradle-backed helper scripts fail early with that discovery checklist when no SDK is found; direct `gradlew` invocations still need one of those env vars or `local.properties`.

## Macrobenchmark (Startup + Frame Timing)

```bash
cd apps/android
./gradlew :benchmark:connectedDebugAndroidTest
```

Reports are written under:

- `apps/android/benchmark/build/reports/androidTests/connected/`

## Perf CLI (low-noise)

Deterministic startup measurement + hotspot extraction with compact CLI output.

Prerequisites:

- Node.js 22+ (the repository runtime baseline; also used for atomic benchmark snapshot publication)
- `adb`
- `jq` for `perf-startup-benchmark.sh`
- `uv` and a complete Android NDK `simpleperf` bundle with `app_profiler.py` plus the bundled host report binary for `perf-startup-hotspots.sh`; both the current activity-launch interface and the legacy `--profile_from_launch` interface are supported, and `simpleperf` is discoverable via `ANDROID_NDK_HOME` / `ANDROID_NDK_ROOT` (NDK root or direct `simpleperf` dir), `ndk.dir` in `local.properties`, `ANDROID_SDK_ROOT`, `ANDROID_HOME`, `~/Android/Sdk`, or `~/Library/Android/sdk`

```bash
cd apps/android
./scripts/perf-startup-benchmark.sh
./scripts/perf-startup-hotspots.sh
# if multiple devices are attached:
./scripts/perf-startup-benchmark.sh --serial <adb-serial>
./scripts/perf-startup-hotspots.sh --serial <adb-serial>
# compare against a specific prior startup snapshot:
./scripts/perf-startup-benchmark.sh --baseline benchmark/results/startup-<timestamp>.<suffix>.json
# capture a shorter hotspot sample to a known path:
./scripts/perf-startup-hotspots.sh --duration 5 --out /tmp/openclaw-startup.perf.data
# override app ABI detection when using a legacy app_profiler.py release:
./scripts/perf-startup-hotspots.sh --arch arm64
# profile an already-installed custom package:
./scripts/perf-startup-hotspots.sh --package <pkg> --activity <activity> --no-install
# install a custom target before profiling it:
./scripts/perf-startup-hotspots.sh --package <pkg> --activity <activity> --install-task <gradle-task-path>
```

Repo-root wrappers are also available:

```bash
pnpm android:perf:startup
pnpm android:perf:hotspots
pnpm android:perf:startup -- --serial <adb-serial>
pnpm android:perf:hotspots -- --serial <adb-serial>
pnpm android:perf:startup -- --baseline apps/android/benchmark/results/startup-<timestamp>.<suffix>.json
pnpm android:perf:hotspots -- --duration 5 --out /tmp/openclaw-startup.perf.data
# legacy app_profiler.py releases only:
pnpm android:perf:hotspots -- --arch arm64
pnpm android:perf:hotspots -- --package <pkg> --activity <activity> --no-install
pnpm android:perf:hotspots -- --package <pkg> --activity <activity> --install-task <gradle-task-path>
```

When using the `pnpm android:*` wrappers, path arguments such as `--baseline` and `--out` are resolved from the repo root.

Benchmark script behavior:

- Runs only `StartupMacrobenchmark#coldStartup` (10 iterations).
- Auto-selects a single connected device, or requires `--serial` when multiple devices are attached.
- Prints a normalized `device_context` token so local baselines are easy to group by device brand, model, and SDK.
- Prints median/min/max/COV in one line.
- Writes local, git-ignored timestamped snapshot JSON to `apps/android/benchmark/results/`.
- Set `ANDROID_BENCHMARK_RESULTS_DIR` to write/read snapshots from a different local directory.
- Set `ANDROID_BENCHMARK_BUILD_OUTPUTS_DIR` when Gradle writes benchmark artifacts to a nonstandard build-output directory; this also isolates parallel scripted runs that use separate Gradle build trees.
- Auto-compares with the latest compatible local snapshot from the same device brand + model + SDK + OS build fingerprint (or pass explicit baseline: `--baseline <old-benchmarkData.json>`).
- Prints the selected `baseline_json` path whenever a baseline comparison is made.
- Uses high-resolution cross-platform file timestamps on macOS and Linux when choosing the latest snapshot.
- Skips implicit comparison when no compatible local snapshot exists, instead of reporting misleading cross-device deltas.
- Verifies a selected baseline's median against its 10 raw runs before calculating a delta, so a corrupted summary cannot report a false regression.
- Fails closed if the current run does not emit a fresh `benchmarkData.json`, instead of silently reusing stale build artifacts.
- Copies that fresh Gradle output once and validates the stable copy, so concurrent writes cannot mix metrics or device context from different runs.

Hotspot script behavior:

- Installs the OpenClaw debug app by default, then captures startup `simpleperf` data for `.MainActivity`.
- Detects the bundled `app_profiler.py` interface and supports both current NDK releases (where `-a` starts profiling before activity launch) and legacy releases that require `--profile_from_launch`; because those legacy releases set `security.perf_harden=0`, the wrapper snapshots, restores, and verifies the original property value before publishing a capture, while refusing to overwrite an unexpected concurrent property change.
- Refuses to invoke Simpleperf when the selected `adb` daemon is already root, because upstream `--disable_adb_root` would otherwise run `adb unroot` and change daemon privilege behind the operator's back. On the normal `shell` daemon path, all supported releases receive `--disable_adb_root`; current releases leave the opt-in `--compile_java_code` flag unset, and legacy releases receive `-nc` to avoid changing the app's compilation mode.
- For legacy releases, detects the installed package ABI, falls back to the device ABI for ABI-neutral packages, and supports an explicit `--arch arm|arm64|x86|x86_64` override. Current releases select the device architecture automatically and reject `--arch` instead of silently ignoring it.
- Auto-selects a single connected device, or requires `--serial` when multiple devices are attached.
- Supports `--no-install` for already-installed custom targets and requires `--no-install` or `--install-task <gradle-task-path>` when `--package` targets a non-OpenClaw app.
- Rejects malformed custom `--package` application IDs (at least two dot-separated segments) and `--activity` values before invoking `adb` or `simpleperf`.
- Prints top DSOs, top symbols, and key app-path clues (Compose/MainActivity/WebView).
- Isolates Simpleperf's transient `binary_cache/` in a per-run temporary directory, requires it to contain captured binaries, and passes it to every host report via `--symfs` so app/native symbols resolve without dirtying the source checkout or reusing an earlier run's binaries.
- Invokes Simpleperf's bundled host report binary directly, avoiding the GUI-only Tk import required by older `report.py` wrappers, and normalizes text-only, comma-CSV, and custom-separator CSV reporter generations into the same validated summary path.
- Fails closed if the Simpleperf reporter emits empty/malformed self-time or children output, instead of printing blank hotspot summaries.
- Writes target package/activity, duration, install task, device serial, NDK path, and raw `perf.data` path for deeper follow-up if needed.
- Pass `--duration <seconds>` to adjust the capture window and `--out <perf.data>` to control the raw output file; parent directories are created, an unchanged existing regular file is replaced only after capture produces non-empty validated data, and directories, symlinks, special files, or outputs changed during capture are rejected as targets.

## Run on a Real Android Phone (USB)

1) On phone, enable **Developer options** + **USB debugging**.
2) Connect by USB and accept the debugging trust prompt on phone.
3) Verify ADB can see the device:

```bash
adb devices -l
```

4) Install + launch debug build:

```bash
pnpm android:install
pnpm android:run
```

These wrappers now auto-select a single connected device, or fail closed when multiple devices are attached. To target one device explicitly:

```bash
ANDROID_SERIAL=<adb-serial> pnpm android:install
ANDROID_SERIAL=<adb-serial> pnpm android:run
# or pass args through pnpm
pnpm android:install -- --serial <adb-serial>
pnpm android:run -- --serial <adb-serial>
```

For `pnpm android:run` custom package/activity targets, pass `--no-install` when the target is already installed, or `--task <gradle-install-task-path>` when the wrapper should install that target before launch. Activity names can be package-relative (`.MainActivity`), bare (`MainActivity`, normalized to `.MainActivity`), or fully qualified (`com.example.MainActivity`). Custom task values must be Gradle install task paths whose final task segment starts with `install`, such as `:app:installDebug` or `:benchmark:installDebug`.

If `adb devices -l` shows `unauthorized`, re-plug and accept the trust prompt again.

### USB-only gateway testing (no LAN dependency)

Use `adb reverse` so Android `localhost:18789` tunnels to your laptop `localhost:18789`.

Terminal A (gateway):

```bash
pnpm openclaw gateway --port 18789 --verbose
```

Terminal B (USB tunnel):

```bash
adb reverse tcp:18789 tcp:18789
```

Then in app **Connect → Manual**:

- Host: `127.0.0.1`
- Port: `18789`
- TLS: off

## Hot Reload / Fast Iteration

This app is native Kotlin + Jetpack Compose.

- For Compose UI edits: use Android Studio **Live Edit** on a debug build (works on physical devices; project `minSdk=31` already meets API requirement).
- For many non-structural code/resource changes: use Android Studio **Apply Changes**.
- For structural/native/manifest/Gradle changes: do full reinstall (`pnpm android:run`, optionally with `ANDROID_SERIAL=<adb-serial>` when multiple devices are attached).
- Canvas web content already supports live reload when loaded from Gateway `__openclaw__/canvas/` (see `docs/platforms/android.md`).

## Connect / Pair

1) Start the gateway (on your main machine):

```bash
pnpm openclaw gateway --port 18789 --verbose
```

2) In the Android app:

- Open the **Connect** tab.
- Use **Setup Code** or **Manual** mode to connect.

3) Approve pairing (on the gateway machine):

```bash
openclaw devices list
openclaw devices approve <requestId>
```

More details: `docs/platforms/android.md`.

## Permissions

- Discovery:
  - Android 13+ (`API 33+`): `NEARBY_WIFI_DEVICES`
  - Android 12 and below: `ACCESS_FINE_LOCATION` (required for NSD scanning)
- Foreground service notification (Android 13+): `POST_NOTIFICATIONS`
- Camera:
  - `CAMERA` for `camera.snap` and `camera.clip`
  - `RECORD_AUDIO` for `camera.clip` when `includeAudio=true`

## Integration Capability Test (Preconditioned)

This suite assumes setup is already done manually. It does **not** install/run/pair automatically.

Pre-req checklist:

1) Gateway is running and reachable from the Android app.
2) Android app is connected to that gateway and `openclaw nodes status` shows it as paired + connected.
3) App stays unlocked and in foreground for the whole run.
4) Open the app **Screen** tab and keep it active during the run (canvas/A2UI commands require the canvas WebView attached there).
5) Grant runtime permissions for capabilities you expect to pass (camera/mic/location/notification listener/location, etc.).
6) No interactive system dialogs should be pending before test start.
7) Canvas host is enabled and reachable from the device (do not run gateway with `OPENCLAW_SKIP_CANVAS_HOST=1`; startup logs should include `canvas host mounted at .../__openclaw__/`).
8) Local operator test client pairing is approved. If first run fails with `pairing required`, approve latest pending device pairing request, then rerun:
9) For A2UI checks, keep the app on **Screen** tab; the node now auto-refreshes canvas capability once on first A2UI reachability failure (TTL-safe retry).

```bash
openclaw devices list
openclaw devices approve --latest
```

Run:

```bash
pnpm android:test:integration
```

Optional overrides:

- `OPENCLAW_ANDROID_GATEWAY_URL=ws://...` (default: from your local OpenClaw config)
- `OPENCLAW_ANDROID_GATEWAY_TOKEN=...`
- `OPENCLAW_ANDROID_GATEWAY_PASSWORD=...`
- `OPENCLAW_ANDROID_NODE_ID=...` or `OPENCLAW_ANDROID_NODE_NAME=...`

What it does:

- Reads `node.describe` command list from the selected Android node.
- Invokes advertised non-interactive commands.
- Skips `screen.record` in this suite (Android requires interactive per-invocation screen-capture consent).
- Asserts command contracts (success or expected deterministic error for safe-invalid calls like `sms.send`, `notifications.actions`, `app.update`).

Common failure quick-fixes:

- `pairing required` before tests start:
  - approve pending device pairing (`openclaw devices approve --latest`) and rerun.
- `A2UI host not reachable` / `A2UI_HOST_NOT_CONFIGURED`:
  - ensure gateway canvas host is running and reachable, keep the app on the **Screen** tab. The app will auto-refresh canvas capability once; if it still fails, reconnect app and rerun.
- `NODE_BACKGROUND_UNAVAILABLE: canvas unavailable`:
  - app is not effectively ready for canvas commands; keep app foregrounded and **Screen** tab active.

## Contributions

This Android app is currently being rebuilt.
Maintainer: @obviyus. For issues/questions/contributions, please open an issue or reach out on Discord.
