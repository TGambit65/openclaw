---
summary: "Android app (node): connection runbook + Connect/Chat/Voice/Canvas command surface"
read_when:
  - Pairing or reconnecting the Android node
  - Debugging Android gateway discovery or auth
  - Verifying chat history parity across clients
title: "Android App"
---

# Android App (Node)

## Support snapshot

- Role: companion node app (Android does not host the Gateway).
- Gateway required: yes (run it on macOS, Linux, or Windows via WSL2).
- Install: [Getting Started](/start/getting-started) + [Pairing](/channels/pairing).
- Gateway: [Runbook](/gateway) + [Configuration](/gateway/configuration).
  - Protocols: [Gateway protocol](/gateway/protocol) (nodes + control plane).

## System control

System control (launchd/systemd) lives on the Gateway host. See [Gateway](/gateway).

## Source Checkout Tooling

From a source checkout, Android install/run wrappers live at the repo root:

```bash
pnpm android:install
pnpm android:run
```

The wrappers auto-select a single connected `adb` device and fail closed when multiple devices are attached. To target one device:

```bash
ANDROID_SERIAL=<adb-serial> pnpm android:install
ANDROID_SERIAL=<adb-serial> pnpm android:run
pnpm android:install -- --serial <adb-serial>
pnpm android:run -- --serial <adb-serial>
```

For `pnpm android:run` custom package/activity targets, pass `--no-install` when the target is already installed, or `--task <gradle-install-task-path>` when the wrapper should install that target before launch. Activity names can be package-relative (`.MainActivity`), bare (`MainActivity`, normalized to `.MainActivity`), or fully qualified (`com.example.MainActivity`). Custom task values must be Gradle install task paths whose final task segment starts with `install`, such as `:app:installDebug` or `:benchmark:installDebug`.

The helper scripts and repo-root Android scripts set `ANDROID_SDK_ROOT` / `ANDROID_HOME` from existing env, `apps/android/local.properties`, or common SDK locations (`~/Android/Sdk` on Linux and `~/Library/Android/sdk` on macOS). Gradle-backed helper scripts fail early with that discovery checklist when no SDK is found; direct `gradlew` invocations still need one of those env vars or `local.properties`.

Low-noise startup perf tools live in `apps/android/scripts/`:

```bash
cd apps/android
./scripts/perf-startup-benchmark.sh
./scripts/perf-startup-hotspots.sh
```

The same tools are available from the repo root:

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

Both perf scripts require `adb` and a connected device:

- `perf-startup-benchmark.sh` also requires `jq`, writes local git-ignored timestamped snapshots under `apps/android/benchmark/results/` (or `ANDROID_BENCHMARK_RESULTS_DIR`), and compares only against compatible local snapshots from the same device brand, model, SDK, and OS build fingerprint unless `--baseline <benchmarkData.json>` is passed explicitly. Before calculating a delta, it verifies the selected baseline's median against its 10 raw runs.
- `perf-startup-hotspots.sh` requires `uv` and a complete Android NDK `simpleperf` bundle with `app_profiler.py` plus the bundled host report binary, discovered through `ANDROID_NDK_HOME` / `ANDROID_NDK_ROOT` (NDK root or direct `simpleperf` dir), `ndk.dir` in `apps/android/local.properties`, SDK roots (`ANDROID_SDK_ROOT` / `ANDROID_HOME`), or common home SDK locations (`~/Android/Sdk`, `~/Library/Android/sdk`). It detects and supports both the current activity-launch interface and the legacy `--profile_from_launch` interface, starts Simpleperf before launching the target activity, and refuses to invoke it when the selected `adb` daemon is already root because upstream `--disable_adb_root` would otherwise run `adb unroot`. On the normal `shell` daemon path, it passes `--disable_adb_root` and avoids changing the app's compilation mode. Because legacy releases also set `security.perf_harden=0`, the wrapper snapshots, restores, and verifies the original property value before publishing a capture, while refusing to overwrite an unexpected concurrent property change. Legacy releases use package/device ABI detection and accept `--arch arm|arm64|x86|x86_64`; current releases select the device architecture automatically and reject `--arch`. The script invokes the bundled host report binary directly so older `report.py` wrappers do not add a Tk dependency, normalizes text-only and CSV reporter generations into one validated summary path, prints the selected interface, NDK and reporter paths plus capture duration, keeps Simpleperf's transient `binary_cache/` in per-run scratch space, requires and passes that cache to every report via `--symfs`, and fails closed when the reporter returns empty or malformed self-time/children output.
- `perf-startup-hotspots.sh` installs the OpenClaw debug app by default. Use `--duration <seconds>` to adjust the sample window, `--out <perf.data>` to choose the raw capture path, `--no-install` for already-installed custom targets, or `--install-task <gradle-install-task-path>` when profiling a custom package that should be installed first. An unchanged existing regular output file is replaced only after capture produces non-empty validated data; directories, symlinks, special files, and outputs changed during capture are rejected.
- Custom `--package` values must be Android application IDs with at least two dot-separated segments, custom `--activity` values must be valid Android component names, and custom install task values must be Gradle task paths whose final task segment starts with `install`, such as `:app:installDebug` or `:benchmark:installDebug`.

## Connection Runbook

Android node app ⇄ (mDNS/NSD + WebSocket) ⇄ **Gateway**

Android connects directly to the Gateway WebSocket (default `ws://<host>:18789`) and uses device pairing (`role: node`).

### Prerequisites

- You can run the Gateway on the “master” machine.
- Android device/emulator can reach the gateway WebSocket:
  - Same LAN with mDNS/NSD, **or**
  - Same Tailscale tailnet using Wide-Area Bonjour / unicast DNS-SD (see below), **or**
  - Manual gateway host/port (fallback)
- You can run the CLI (`openclaw`) on the gateway machine (or via SSH).

### 1) Start the Gateway

```bash
openclaw gateway --port 18789 --verbose
```

Confirm in logs you see something like:

- `listening on ws://0.0.0.0:18789`

For tailnet-only setups (recommended for Vienna ⇄ London), bind the gateway to the tailnet IP:

- Set `gateway.bind: "tailnet"` in `~/.openclaw/openclaw.json` on the gateway host.
- Restart the Gateway / macOS menubar app.

### 2) Verify discovery (optional)

From the gateway machine:

```bash
dns-sd -B _openclaw-gw._tcp local.
```

More debugging notes: [Bonjour](/gateway/bonjour).

#### Tailnet (Vienna ⇄ London) discovery via unicast DNS-SD

Android NSD/mDNS discovery won’t cross networks. If your Android node and the gateway are on different networks but connected via Tailscale, use Wide-Area Bonjour / unicast DNS-SD instead:

1. Set up a DNS-SD zone (example `openclaw.internal.`) on the gateway host and publish `_openclaw-gw._tcp` records.
2. Configure Tailscale split DNS for your chosen domain pointing at that DNS server.

Details and example CoreDNS config: [Bonjour](/gateway/bonjour).

### 3) Connect from Android

In the Android app:

- The app keeps its gateway connection alive via a **foreground service** (persistent notification).
- Open the **Connect** tab.
- Use **Setup Code** or **Manual** mode.
- If discovery is blocked, use manual host/port (and TLS/token/password when required) in **Advanced controls**.

After the first successful pairing, Android auto-reconnects on launch:

- Manual endpoint (if enabled), otherwise
- The last discovered gateway (best-effort).

### 4) Approve pairing (CLI)

On the gateway machine:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

Pairing details: [Pairing](/channels/pairing).

### 5) Verify the node is connected

- Via nodes status:

  ```bash
  openclaw nodes status
  ```

- Via Gateway:

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6) Chat + history

The Android Chat tab supports session selection (default `main`, plus other existing sessions):

- History: `chat.history`
- Send: `chat.send`
- Push updates (best-effort): `chat.subscribe` → `event:"chat"`

### 7) Canvas + screen + camera

#### Gateway Canvas Host (recommended for web content)

If you want the node to show real HTML/CSS/JS that the agent can edit on disk, point the node at the Gateway canvas host.

Note: nodes load canvas from the Gateway HTTP server (same port as `gateway.port`, default `18789`).

1. Create `~/.openclaw/workspace/canvas/index.html` on the gateway host.

2. Navigate the node to it (LAN):

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18789/__openclaw__/canvas/"}'
```

Tailnet (optional): if both devices are on Tailscale, use a MagicDNS name or tailnet IP instead of `.local`, e.g. `http://<gateway-magicdns>:18789/__openclaw__/canvas/`.

This server injects a live-reload client into HTML and reloads on file changes.
The A2UI host lives at `http://<gateway-host>:18789/__openclaw__/a2ui/`.

Canvas commands (foreground only):

- `canvas.eval`, `canvas.snapshot`, `canvas.navigate` (use `{"url":""}` or `{"url":"/"}` to return to the default scaffold). `canvas.snapshot` returns `{ format, base64 }` (default `format="jpeg"`).
- A2UI: `canvas.a2ui.push`, `canvas.a2ui.reset` (`canvas.a2ui.pushJSONL` legacy alias)

Camera commands (foreground only; permission-gated):

- `camera.snap` (jpg)
- `camera.clip` (mp4)

See [Camera node](/nodes/camera) for parameters and CLI helpers.

Screen commands:

- `screen.record` (mp4; foreground only)

### 8) Voice + expanded Android command surface

- Voice: Android uses a single mic on/off flow in the Voice tab with transcript capture and TTS playback (ElevenLabs when configured, system TTS fallback).
- Voice wake/talk-mode toggles are currently removed from Android UX/runtime.
- Additional Android command families (availability depends on device + permissions):
  - `device.status`, `device.info`, `device.permissions`, `device.health`
  - `notifications.list`, `notifications.actions`
  - `photos.latest`
  - `contacts.search`, `contacts.add`
  - `calendar.events`, `calendar.add`
  - `motion.activity`, `motion.pedometer`
  - `app.update`
