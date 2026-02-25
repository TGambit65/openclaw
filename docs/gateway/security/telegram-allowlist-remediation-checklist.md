---
summary: "Focused non-destructive remediation checklist for gateway warnings: allowlists + Telegram group controls"
read_when:
  - Triage channel warnings from `openclaw doctor` or `openclaw channels status --probe`
  - Hardening Telegram DM/group access without auto-changing config
title: "Telegram Allowlists & Group Controls — Remediation Checklist"
---

# Telegram Allowlists & Group Controls — Remediation Checklist

## Scope

This checklist targets gateway warnings related to:

- allowlists
- Telegram group mention policy (`requireMention`)
- Telegram group reachability/probing with explicit numeric group IDs

It is **non-destructive**: inspect and patch manually; do not auto-apply config changes.

---

## 1) Run non-destructive checks

```bash
openclaw channels status --probe
openclaw doctor
```

High-signal warnings to remediate (exact wording may vary):

1. `Config allows unmentioned group messages (requireMention=false). Telegram Bot API privacy mode will block most group messages unless disabled.`
2. `Telegram groups config uses "*" with requireMention=false; membership probing is not possible without explicit group IDs.`

---

## 2) Key config paths to audit (exact keys)

### Global/default account

- `channels.telegram.dmPolicy`
- `channels.telegram.allowFrom`
- `channels.telegram.groupPolicy`
- `channels.telegram.groupAllowFrom`
- `channels.telegram.groups`
- `channels.telegram.groups."*".requireMention`
- `channels.telegram.groups."<chatId>".requireMention`
- `channels.telegram.groups."<chatId>".groupPolicy`
- `channels.telegram.groups."<chatId>".allowFrom`

### Per-account override (if using multi-account Telegram)

- `channels.telegram.accounts.<accountId>.dmPolicy`
- `channels.telegram.accounts.<accountId>.allowFrom`
- `channels.telegram.accounts.<accountId>.groupPolicy`
- `channels.telegram.accounts.<accountId>.groupAllowFrom`
- `channels.telegram.accounts.<accountId>.groups`

### Format requirements (important)

- Group keys under `channels.telegram.groups` should be **numeric chat IDs** (example: `"-1001234567890"`) for probeability.
- `allowFrom` / `groupAllowFrom` should be numeric Telegram sender IDs (prefixes `telegram:` / `tg:` are normalized).

---

## 3) Safe patch patterns (manual examples)

## A. Safe baseline (recommended): mention-gated groups

Use this when you want minimal exposure and no privacy-mode dependency for non-mention traffic.

```json5
{
  channels: {
    telegram: {
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      groups: {
        "*": { requireMention: true },
        "-1001234567890": { requireMention: true },
      },
    },
  },
}
```

Why: keeps group replies mention-triggered; explicit group IDs also support reliable probing.

## B. Controlled always-on group(s): explicit IDs only

Use this only for trusted groups where bot should react without mention.

```json5
{
  channels: {
    telegram: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["123456789", "987654321"],
      groups: {
        "-1001234567890": {
          requireMention: false,
          groupPolicy: "allowlist",
        },
        "*": { requireMention: true },
      },
    },
  },
}
```

Why: avoids wildcard non-mention behavior; preserves per-group control and probe coverage.

## C. If you intentionally use `requireMention=false`

Operational requirement outside config:

- In BotFather run `/setprivacy` → Disable for this bot.
- Re-add bot to affected group(s) if needed.
- Restart gateway, then re-run:

```bash
openclaw channels status --probe
```

---

## 4) Anti-patterns to remove

- `channels.telegram.groups."*".requireMention = false` without explicit numeric group IDs.
- `channels.telegram.groupPolicy = "open"` in untrusted groups.
- non-numeric `allowFrom` / `groupAllowFrom` entries that cannot match sender IDs reliably.

---

## 5) Fast verification after manual patch

```bash
openclaw doctor
openclaw channels status --probe
openclaw logs --follow
```

Expected result:

- no Telegram warning about wildcard + `requireMention=false`
- no warning about unmentioned groups unless intentionally configured
- probe output can evaluate explicitly listed numeric groups

---

## Notes

- `openclaw doctor --fix` may resolve some issues automatically, but for security-sensitive access controls prefer explicit manual review.
- Keep DM and group controls tight first (`pairing` / `allowlist`), then relax only with documented justification.
