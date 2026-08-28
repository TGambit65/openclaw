# Finish Check — android-hotspots-symbol-cache-20260724

Status: PASS
Started: 2026-07-24 18:03 PDT

## Definition of Done

- [x] Regression requires every report to receive the per-run binary cache via --symfs
- [x] Missing binary cache fails before publishing perf.data
- [x] Android shell suite passes
- [x] Shell syntax and diff checks pass

## Item Verification

| Item                                | Pass | Evidence | Timestamp            | Notes                                                                        |
| ----------------------------------- | ---- | -------- | -------------------- | ---------------------------------------------------------------------------- |
| perf-startup-hotspots.sh            | [x]  | [x]      | 2026-07-24 18:03 PDT | Requires the per-run cache and supplies it to all three report paths.        |
| scripts/test-android-shell-tools.sh | [x]  | [x]      | 2026-07-24 18:03 PDT | Verifies `--symfs` wiring and fail-closed behavior when the cache is absent. |
| Android performance docs            | [x]  | [x]      | 2026-07-24 18:03 PDT | README and platform docs describe required symbol-cache behavior.            |

## Failure Log

- Initial reproduction: add `OPENCLAW_REQUIRE_REPORT_SYMFS=1` to the primary hotspot fixture and run `pnpm test:android:shell-tools`. Before the source fix, the suite exited 1 because the fake reporter received an empty `--symfs` path. After passing `$tmp_dir/binary_cache` to every host report, the same suite passes.
