# Preflight Intake (REQUIRED)

Task ID: pr-fix-issues-2026-03-10
Owner: Cairn
Date: 2026-03-10

## 1) Scope

- In-scope paths/pages: openclaw repo; PRs #36114, #20844, #13042, #13032, #13014, #7983, #7953 (verify relevance + fix open issues)
- Out-of-scope paths/pages: non-openclaw repos; unrelated PRs; feature expansion beyond stated issues

## 2) Definition of Done

- What must be true to call this complete?
- Each listed PR reviewed for current relevance; issues identified and fixed; CI green or explicitly documented; PRs updated with fixes and evidence.

## 3) Verification Types

- [ ] Visual
- [ ] Functional click/path
- [x] Tests/lint/build
- [ ] Performance
- [x] Security
- [x] Other: PR review + issue resolution

## 4) Evidence Required

- Evidence artifact types (screenshots/logs/test output/etc): CI logs, test output, PR update notes, diff summaries
- Minimum evidence count: 1 per PR (7 total)

## 5) Coverage

- [x] Every page/file in scope
- [ ] Sampling (define exact sample):

## 6) Environments

- [x] Desktop
- [ ] Mobile
- [ ] Staging
- [ ] Prod
- [x] Other: GitHub PRs / CI

## 7) Failure Policy

- [ ] Stop on first fail
- [x] Continue and log all fails

## 8) Report Format

- Output format required: checklist + report with per-PR status and evidence links

## 9) Hard Blockers

- Missing repo access, missing CI credentials, or failing tests without repro details

## 10) Sign-off Rule

- Who approves final pass? Kelly
