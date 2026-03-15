# PR #7983 — secure coding guidelines in system prompt

## Objective

Verify PR is CI-stable and improve only if there are concrete quality or correctness gaps.

## Tasks

- [ ] Verify current status and reproduce checks locally.
- [ ] Review prompt text for clarity, non-contradiction, and enforceability.
- [ ] Fix any failing or flaky checks tied to prompt/schema/docs.
- [ ] Keep wording concise and avoid policy conflicts with existing guardrails.
- [ ] Produce merge-readiness summary and recommended follow-ups.
- [ ] Commit only if changes are needed.

## Validation

- `pnpm check`
- `pnpm lint`
- `pnpm test`
