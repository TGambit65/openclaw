---
title: CI Pipeline
description: How the OpenClaw CI pipeline works
summary: "CI job graph, scope gates, and local command equivalents"
read_when:
  - You need to understand why a CI job did or did not run
  - You are debugging failing GitHub Actions checks
---

# CI Pipeline

The CI runs on every push to `main` and every pull request. Pull requests use smart scoping to skip expensive unrelated jobs; pushes to `main` keep broad coverage except for docs-only changes.

## Job Overview

| Job                   | Purpose                                                 | When it runs                                      |
| --------------------- | ------------------------------------------------------- | ------------------------------------------------- |
| `docs-scope`          | Detect docs-only changes                                | Always                                            |
| `changed-scope`       | Detect which areas changed (node/macos/android/windows) | Non-docs pushes and PRs                           |
| `check`               | TypeScript types, lint, format                          | Push to `main`, or PRs with Node-relevant changes |
| `check-docs`          | Markdown lint + broken link check                       | Docs changed                                      |
| `secrets`             | Detect leaked secrets                                   | Always                                            |
| `build-artifacts`     | Build dist once, share with other jobs                  | Push to `main`, or PRs with Node-relevant changes |
| `release-check`       | Validate npm pack contents                              | After build on push to `main`                     |
| `checks`              | Node/Bun tests + protocol check                         | Push to `main`, or PRs with Node-relevant changes |
| `android-shell-tools` | Android helper-script smoke tests                       | Push to `main`, or PRs with Android/Node changes  |
| `skills-python`       | Python lint/tests for skill scripts                     | Push to `main`, or PRs with Node-relevant changes |
| `checks-windows`      | Windows-specific tests                                  | Push to `main`, or PRs with Windows changes       |
| `macos`               | Swift lint/build/test + TS tests                        | PRs with macOS changes                            |
| `ios`                 | iOS native checks                                       | Defined but currently disabled                    |
| `android`             | Gradle build + tests                                    | Push to `main`, or PRs with Android changes       |

## Fail-Fast Order

Jobs are ordered so cheap checks fail before expensive ones run:

1. `docs-scope` runs first so docs-only changes can skip heavy jobs.
2. `changed-scope` runs for non-docs changes and feeds the platform/job gates.
3. Scoped validation jobs run from those outputs; `build-artifacts` runs on pushes to `main`, or on PRs when Node coverage is required.
4. `checks`, `android-shell-tools`, `skills-python`, `checks-windows`, `macos`, and `android` run when their scope gates match.

Scope logic lives in `scripts/ci-changed-scope.mjs` and is covered by unit tests in `src/scripts/ci-changed-scope.test.ts`.

## Runners

| Runner                           | Jobs                                       |
| -------------------------------- | ------------------------------------------ |
| `blacksmith-16vcpu-ubuntu-2404`  | Most Linux jobs, including scope detection |
| `blacksmith-32vcpu-windows-2025` | `checks-windows`                           |
| `macos-latest`                   | `macos`, `ios`                             |

## Local Equivalents

```bash
pnpm check                     # types + lint + format
pnpm test                      # vitest tests
pnpm test:android:shell-tools  # Android helper-script smoke tests
pnpm check:docs                # docs format + lint + broken links
pnpm release:check             # validate npm pack
```
