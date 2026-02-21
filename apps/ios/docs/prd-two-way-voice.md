# PRD — Two‑Way Voice Communications (iOS)

**Product:** OpenClaw iOS

**Owner:** iOS App

**Last updated:** 2026‑02‑21

---

## 0) Reverse‑engineering brief — Current iOS voice architecture

### Chat transport / gateway
- **Gateway sessions:** `NodeAppModel` owns two `GatewayNodeSession` connections:
  - `nodeGateway` (device capabilities, node.invoke, events)
  - `operatorGateway` (chat/talk/config/voicewake)
- **Chat send:** `TalkModeManager.sendChat` calls `operatorGateway.request("chat.send")` with `sessionKey`, `message`, `timeoutMs`, `idempotencyKey`.
- **Completion:** `TalkModeManager.waitForChatCompletion` subscribes to server events (`operatorGateway.subscribeServerEvents`) and watches `chat` events by `runId`.
- **History fallback:** `TalkModeManager.fetchLatestAssistantText` calls `operatorGateway.request("chat.history")` to retrieve the latest assistant message.

### Audio / voice session lifecycle
- **Voice wake (always‑listening):** `VoiceWakeManager`
  - Uses `AVAudioEngine` + `SFSpeechRecognizer` to capture mic audio and perform STT.
  - Wake‑word detection via `SwabbleKit` (`WakeWordGate` + segments).
  - On trigger, calls `NodeAppModel.sendVoiceTranscript` → sends event `voice.transcript` on `nodeGateway`.
  - Permissions: `AVAudioSession.recordPermission`, `SFSpeechRecognizer` permissions with timeout guard.
  - Audio session: `.playAndRecord`, `.measurement`, options (`duckOthers`, `mixWithOthers`, `allowBluetoothHFP`, `defaultToSpeaker`).

- **Talk mode (full conversational STT + TTS):** `TalkModeManager`
  - **STT:** continuous or PTT; `SFSpeechAudioBufferRecognitionRequest` with audio tap on `AVAudioEngine`.
  - **Endpointing:** silence monitor + audio‑level thresholding (`AudioTapDiagnostics`).
  - **PTT:** `beginPushToTalk` / `endPushToTalk` with auto‑stop and timeout.
  - **TTS:** ElevenLabs streaming (PCM preferred, fallback MP3) via `ElevenLabsTTSClient`. Fallback to system voice (`TalkSystemSpeechSynthesizer`).
  - **Incremental TTS:** incremental speech buffer, streaming partial assistant responses when enabled.
  - **Config:** `talk.config` fetched from gateway (voiceId, modelId, outputFormat, apiKey, aliases, interruptOnSpeech). Local override stored via `GatewaySettingsStore`.
  - **Audio session:** `.playAndRecord`, `.spokenAudio`, HFP + speaker; preferred sample rate 48k, IO buffer 20ms.

- **Mic arbitration:** `NodeAppModel` suppresses `VoiceWakeManager` when talk mode is enabled (and resumes on disable). Talk can suspend/resume in background.

### Voice wake sync & settings
- **Wake words:** `VoiceWakePreferences` stores triggers in `UserDefaults`.
- **Gateway sync:** `NodeAppModel.startVoiceWakeSync` subscribes to server events; handles `voicewake.changed` and `talk.mode` events.
- **Remote get/set:** `voicewake.get` / `voicewake.set` requests on the operator gateway.

### Push / wake / background constraints
- **Background modes:** `UIBackgroundModes = [audio, remote-notification]`.
- **APNs:** Device token registration sent via `push.apns.register` (node gateway).
- **Silent push wake:** `handleSilentPushWake` → `reconnectGatewaySessionsForSilentPushIfNeeded`, with reconnect lease and background task grace (25s default).
- **Background refresh & significant location:** also trigger reconnect.
- **Foreground resumption:** On scene active, reconnects and restarts health monitor; forces socket refresh when backgrounded > 3s.
- **Talk in background:** `talk.background.enabled` can keep talk active, otherwise suspend microphone and subscriptions.

### UI
- **Voice tab:** `VoiceTab.swift` shows wake status and talk enabled state.
- **Talk orb:** `TalkOrbOverlay` provides visual mic level + tap to stop speech output.

---

## 1) Problem statement
OpenClaw iOS currently provides **voice wake** and **talk mode** (STT → chat → TTS). This works for short interactions but is not yet a **robust, two‑way voice communication experience**. The product needs a consistent “voice session” that stays resilient through network drops, app backgrounding, audio route changes, and TTS/STT interruptions—without compromising security or pairing boundaries.

We need to evolve from “speech‑in → text‑out” into a **full duplex voice experience** that feels like a natural call with the agent (including quick PTT, interruption handling, and reliable background wake), while preserving battery and privacy.

---

## 2) Goals / non‑goals

### Goals
- **Two‑way voice** with low latency and natural turn‑taking.
- **Resilient session lifecycle**: recover from network, background, and audio interruptions.
- **Clear UX** for permissions, recording, and retry/reconnect.
- **Security‑preserving**: no new auth surface; maintain current pairing/auth scopes.

### Non‑goals (Phase 1–2)
- Full SIP/telephony or CallKit integration.
- Multi‑party voice sessions.
- Third‑party voice assistants beyond OpenClaw gateway.

---

## 3) User stories
1. **Hands‑free assistant:** “As a user, I can say a wake phrase and continue talking without touching the phone.”
2. **Push‑to‑talk:** “As a user, I can hold to talk when I need privacy or precision.”
3. **Continuous conversation:** “As a user, the agent talks back quickly and I can interrupt it naturally.”
4. **Background‑safe:** “As a user, I can lock my phone and keep the voice session alive if I opted in.”
5. **Resilient reconnect:** “If my connection drops, the voice session resumes gracefully.”
6. **Battery aware:** “If the phone is low on battery, the app uses a lower‑power voice mode.”

---

## 4) Functional requirements

### Voice session
- **Session start/stop:** explicit session lifecycle state machine (idle → listening → thinking → speaking → idle).
- **Wake + talk integration:** voice wake may start a voice session or initiate PTT when configured.
- **Barge‑in:** users can interrupt TTS with speech (already supported in `TalkModeManager`).

### Audio capture & playback
- **Duplex audio:** support simultaneous capture + playback when safe; otherwise enforce half‑duplex with clear UX.
- **Audio route changes:** handle Bluetooth/airplay/headset swap; re‑establish audio session and resume capture.
- **PTT auto‑stop:** silence detection or max duration.

### Network / gateway
- **Streaming:** support streaming assistant voice (incremental TTS) and handle partials.
- **Retry/reconnect:** reconnect if `chat.send` or stream fails; keep the user informed.
- **Config sync:** on connect, refresh `talk.config` and `voicewake` triggers.

### Background
- **Opt‑in background talk:** gated by setting (`talk.background.enabled`).
- **Silent push wake:** wake sessions only for trusted pairing / active configs.

### Security
- **No scope expansion:** reuse `GatewayNodeSession` auth; do not bypass pairing approval.
- **Local API keys:** remain local to device; do not log secrets.

---

## 5) Non‑functional requirements

### Latency
- **STT partials:** < 400 ms from speech to partial transcription.
- **Assistant response:** first audio within 1.5–2.5 s of end‑of‑speech.
- **PTT response:** end‑to‑first‑audio < 2.0 s in normal conditions.

### Reliability
- **Session success:** ≥ 98% of sessions complete without manual restart.
- **Reconnect recovery:** ≥ 90% recover within 5 s.

### Battery
- **Idle battery drain:** voice wake < 2%/hr on modern devices.
- **Active session:** degrade gracefully on low power (lower sample rate, shorter keep‑alive).

### Privacy & security
- **Local permissions:** mic + speech prompts only when needed.
- **No hidden recording:** explicit state indicator + ability to stop at any time.
- **Key safety:** ElevenLabs key never logged; redacted when stored or sent.

---

## 6) UX flows

### First‑use permissions
1. User enables Voice or Talk.
2. App requests **Microphone** + **Speech Recognition** permissions.
3. If denied, show guidance + open Settings.

### Voice session
1. User says wake phrase or taps PTT.
2. Orb shows “Listening”.
3. On speech end, show “Thinking…” and play assistant.
4. User can interrupt with speech or tap orb.

### Interruption handling
- If a call/notification interrupts audio session, pause and show “Paused”.
- Resume automatically when audio session becomes active, or user taps Resume.

### Retry / reconnect
- If gateway disconnects mid‑session, show “Reconnecting…” with retry timer.
- Resume conversation if possible; otherwise prompt to retry.

---

## 7) Failure modes & recovery

| Failure | Detection | Recovery | UX message |
| --- | --- | --- | --- |
| Mic permission denied | `recordPermission = .denied` | Show settings deep‑link | “Microphone permission denied.” |
| Speech permission denied | `authorizationStatus = .denied` | Show settings deep‑link | “Speech recognition denied.” |
| Gateway offline | request timeout | auto‑retry + backoff | “Offline. Retrying…” |
| STT engine error | recognition error | restart recognition | “Listening…” |
| TTS failure | streaming error | fallback to system voice | “Speaking (System)…” |
| Audio route change | `AVAudioSession.routeChange` | reset session + resume | “Audio route changed.” |
| Background suspended | app inactive | suspend capture + resume on foreground | “Paused” |

---

## 8) Telemetry / observability

- **Session metrics**: start/stop, duration, success/failure reason.
- **Latency**: STT first partial, end‑of‑speech to TTS start, TTS completion.
- **Audio health**: sample rate, route, tap failures.
- **Network**: chat.send latency, stream errors, reconnect count.
- **Battery**: low‑power mode triggered, background session duration.

(Use existing `GatewayDiagnostics` and `Logger` categories; avoid logging content or keys.)

---

## 9) Rollout plan + acceptance criteria

### Rollout
1. **Phase 1 (Internal)**: ship with feature flag, telemetry only, no background keep‑alive.
2. **Phase 2 (Beta)**: limited opt‑in, improved reconnect, PTT UX.
3. **Phase 3 (Public)**: full two‑way voice with background support (opt‑in), reliability targets met.

### Acceptance criteria
- 95% of sessions complete without user restart.
- Average response latency < 2.5 s.
- No regression in pairing/auth failures.
- Battery drain within targets.

---

## 10) Implementation plan (phased, with code touchpoints)

### Phase 0 — instrumentation + design gates
- **Touchpoints:** `TalkModeManager`, `VoiceWakeManager`, `NodeAppModel`, `GatewayDiagnostics`.
- Add standardized voice session logs/metrics.
- Clarify audio route/interrupt behavior and define state machine.

### Phase 1 — voice session coordinator (foundation)
- **Add `VoiceSessionCoordinator`** to unify `VoiceWakeManager` + `TalkModeManager` state transitions.
- **Touchpoints:**
  - `Sources/Voice/VoiceSessionCoordinator.swift` (new)
  - `NodeAppModel`: replace direct mic arbitration with coordinator API
  - `VoiceWakeManager` / `TalkModeManager`: expose hooks for suspend/resume events
- **Tests:** unit tests for state transitions and arbitration (no audio engine use).

### Phase 2 — robust duplex session
- **Streaming audio**: ensure incremental TTS is default, improve fallback logic.
- **Route change handling**: respond to `AVAudioSession.routeChange`.
- **Touchpoints:** `TalkModeManager`, `StreamingAudioPlayer`, `PCMStreamingAudioPlayer`.

### Phase 3 — background reliability
- **Background audio policy**: explicit session keep‑alive option with battery‑aware limits.
- **Silent push + background refresh**: tighten reconnect policy to avoid churn.
- **Touchpoints:** `NodeAppModel.setScenePhase`, `handleSilentPushWake`, `Info.plist`.

### Phase 4 — UX polish
- Enhance `TalkOrbOverlay` to show reconnecting, muted, and error states.
- Add settings UI for background voice, wake words, and PTT.

---

## Appendix — Phase 1 minimal safe scope (implementation guidance)
- Introduce a **pure Swift** coordinator with unit tests; no audio engine usage required.
- Maintain existing security boundaries: coordinator only controls existing managers.
- Defer any background or streaming changes to later phases.
