// Exact signatures emitted when a gateway restart interrupts an otherwise
// resumable agent turn. Keep these shared so wait, registry, and recovery paths
// cannot disagree about whether the same persisted failure is retryable.
const RESTART_INTERRUPTED_CODEX_BRIDGE_ERROR_RE =
  /\bcodex app-server (?:client|turn route) closed before turn completed\b/iu;
const RESTART_INTERRUPTED_GATEWAY_CLOSE_ERROR_RE = /\bgateway closed \(1012\): service restart\b/iu;

export function isRestartInterruptedAgentError(error: string | undefined): boolean {
  const message = error?.trim();
  return Boolean(
    message &&
    (RESTART_INTERRUPTED_CODEX_BRIDGE_ERROR_RE.test(message) ||
      RESTART_INTERRUPTED_GATEWAY_CLOSE_ERROR_RE.test(message)),
  );
}
