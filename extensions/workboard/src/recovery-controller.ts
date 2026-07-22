// Workboard recovery controller preserves wakeups across asynchronous reconciliation passes.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  isRecoverableWorkerInterruption,
  type WorkboardTerminalRunEvent,
  type WorkboardTerminalSettlementResult,
} from "./dispatcher.js";

export type WorkboardRecoverySource = "startup" | "dispatch" | "subagent-ended" | "continuation";

type WorkboardRecoveryResult = {
  reconciled: string[];
  started: unknown[];
  failures: unknown[];
  needsContinuation: boolean;
  continuationMode?: "bounded" | "durable";
};

type WorkboardRecoveryLogger = {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
};

type WorkboardRecoveryControllerOptions = {
  runRecovery(source: WorkboardRecoverySource): Promise<WorkboardRecoveryResult>;
  settleTerminatedRun(event: WorkboardTerminalRunEvent): Promise<WorkboardTerminalSettlementResult>;
  cleanupRun(event: WorkboardTerminalRunEvent): Promise<unknown>;
  logger: WorkboardRecoveryLogger;
  continuationDelayMs?: number;
  maxContinuationPasses?: number;
  durableContinuationMaxDelayMs?: number;
  terminalRetryDelayMs?: number;
  maxTerminalRetryPasses?: number;
};

const TERMINAL_SETTLEMENT_MAX_ATTEMPTS = 3;

export function createWorkboardRecoveryController(options: WorkboardRecoveryControllerOptions) {
  const continuationDelayMs = Math.max(0, options.continuationDelayMs ?? 1_000);
  const maxContinuationPasses = Math.max(0, Math.trunc(options.maxContinuationPasses ?? 3));
  const durableContinuationMaxDelayMs = Math.max(
    continuationDelayMs,
    options.durableContinuationMaxDelayMs ?? 30_000,
  );
  const terminalRetryDelayMs = Math.max(0, options.terminalRetryDelayMs ?? continuationDelayMs);
  const maxTerminalRetryPasses = Math.max(0, Math.trunc(options.maxTerminalRetryPasses ?? 120));
  let active: Promise<void> | null = null;
  let rerunRequested = false;
  let queuedSource: WorkboardRecoverySource = "continuation";
  let continuationPasses = 0;
  let durableContinuationPasses = 0;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  type ScheduledWake =
    | { kind: "recovery"; source: WorkboardRecoverySource; dueAt: number }
    | {
        kind: "terminal";
        event: WorkboardTerminalRunEvent;
        recoveryEnabled: boolean;
        dueAt: number;
      };
  const scheduledWakeups = new Map<string, ScheduledWake>();
  const terminalRetryPasses = new Map<string, number>();

  function rescheduleWakeTimer(): void {
    if (wakeTimer) {
      clearTimeout(wakeTimer);
      wakeTimer = undefined;
    }
    const nextDueAt = Math.min(...[...scheduledWakeups.values()].map((wake) => wake.dueAt));
    if (!Number.isFinite(nextDueAt)) {
      return;
    }
    wakeTimer = setTimeout(
      () => {
        wakeTimer = undefined;
        void drainScheduledWakeups().catch((error: unknown) => {
          options.logger.warn("workboard scheduled reconciliation failed", {
            error: formatErrorMessage(error),
          });
        });
      },
      Math.max(0, nextDueAt - Date.now()),
    );
    wakeTimer.unref?.();
  }

  function scheduleWake(key: string, wake: ScheduledWake): void {
    const current = scheduledWakeups.get(key);
    if (!current || wake.dueAt < current.dueAt) {
      scheduledWakeups.set(key, wake);
      rescheduleWakeTimer();
    }
  }

  function cancelWake(key: string): void {
    if (scheduledWakeups.delete(key)) {
      rescheduleWakeTimer();
    }
  }

  const scheduleContinuation = (mode: "bounded" | "durable"): void => {
    if (
      scheduledWakeups.has("recovery:continuation") ||
      (mode === "bounded" && continuationPasses >= maxContinuationPasses)
    ) {
      return;
    }
    const delayMs =
      mode === "durable"
        ? Math.min(
            durableContinuationMaxDelayMs,
            continuationDelayMs * 2 ** Math.min(durableContinuationPasses, 20),
          )
        : continuationDelayMs;
    if (mode === "durable") {
      durableContinuationPasses += 1;
    } else {
      continuationPasses += 1;
    }
    scheduleWake("recovery:continuation", {
      kind: "recovery",
      source: "continuation",
      dueAt: Date.now() + delayMs,
    });
  };

  const run = (source: WorkboardRecoverySource): Promise<void> => {
    if (active) {
      rerunRequested = true;
      queuedSource = source;
      return active;
    }
    const operation = (async () => {
      let currentSource = source;
      let needsContinuation = false;
      let continuationMode: "bounded" | "durable" = "bounded";
      try {
        do {
          rerunRequested = false;
          try {
            const result = await options.runRecovery(currentSource);
            needsContinuation = result.needsContinuation;
            continuationMode = result.continuationMode ?? "bounded";
            if (
              result.reconciled.length > 0 ||
              result.started.length > 0 ||
              result.failures.length > 0
            ) {
              options.logger.info("workboard interrupted-run reconciliation completed", {
                source: currentSource,
                reconciled: result.reconciled.length,
                started: result.started.length,
                failures: result.failures.length,
              });
            }
          } catch (error) {
            // Startup reconciliation can fail for transient reasons (for
            // example, the task registry or SQLite store still opening). Keep
            // durable backoff polling so repeated infrastructure failures
            // cannot exhaust the small capacity-overflow retry budget.
            needsContinuation = true;
            continuationMode = "durable";
            options.logger.warn("workboard interrupted-run reconciliation failed", {
              source: currentSource,
              error: formatErrorMessage(error),
            });
          }
          currentSource = queuedSource;
        } while (rerunRequested);
      } finally {
        active = null;
        if (needsContinuation) {
          scheduleContinuation(continuationMode);
        } else {
          continuationPasses = 0;
          durableContinuationPasses = 0;
        }
      }
    })();
    active = operation;
    return operation;
  };

  const terminalEventKey = (event: WorkboardTerminalRunEvent): string =>
    event.runId ? `run:${event.runId}` : `session:${event.targetSessionKey}`;

  const handleTerminalEvent = async (
    event: WorkboardTerminalRunEvent,
    recoveryEnabled: boolean,
    requestRecoveryAfter: boolean,
  ): Promise<void> => {
    const eventKey = terminalEventKey(event);
    let settlement: WorkboardTerminalSettlementResult | undefined;
    let settlementError: unknown;
    for (let attempt = 0; attempt < TERMINAL_SETTLEMENT_MAX_ATTEMPTS; attempt += 1) {
      try {
        settlement = await options.settleTerminatedRun(event);
        if (settlement.status !== "retry-exhausted") {
          break;
        }
      } catch (error) {
        settlementError = error;
      }
    }
    const needsTerminalRetry = !settlement || settlement.status === "retry-exhausted";
    if (needsTerminalRetry) {
      const nextPass = (terminalRetryPasses.get(eventKey) ?? 0) + 1;
      const wakeKey = `terminal:${eventKey}`;
      if (nextPass <= maxTerminalRetryPasses && !scheduledWakeups.has(wakeKey)) {
        terminalRetryPasses.set(eventKey, nextPass);
        scheduleWake(wakeKey, {
          kind: "terminal",
          event,
          recoveryEnabled,
          dueAt: Date.now() + terminalRetryDelayMs,
        });
      } else if (nextPass > maxTerminalRetryPasses) {
        options.logger.warn("workboard terminal run settlement retry budget exhausted", {
          runId: event.runId,
          sessionKey: event.targetSessionKey,
          attempts: nextPass - 1,
          error: settlement?.error ?? formatErrorMessage(settlementError),
        });
      }
      options.logger.warn("workboard terminal run settlement failed", {
        runId: event.runId,
        sessionKey: event.targetSessionKey,
        error: settlement?.error ?? formatErrorMessage(settlementError),
      });
    } else {
      terminalRetryPasses.delete(eventKey);
      cancelWake(`terminal:${eventKey}`);
      if (
        settlement &&
        (settlement.status === "settled" ||
          settlement.status === "already-terminal" ||
          settlement.status === "unmanaged")
      ) {
        try {
          await options.cleanupRun(event);
        } catch (error) {
          options.logger.warn("workboard run cleanup failed", {
            runId: event.runId,
            sessionKey: event.targetSessionKey,
            error: formatErrorMessage(error),
          });
        }
      }
    }
    if (requestRecoveryAfter && (recoveryEnabled || settlement?.status === "completion-owned")) {
      await run("subagent-ended");
    }
  };

  async function drainScheduledWakeups(): Promise<void> {
    const now = Date.now();
    const due = [...scheduledWakeups.entries()]
      .filter(([, wake]) => wake.dueAt <= now)
      .toSorted(([, left], [, right]) => left.dueAt - right.dueAt);
    for (const [key] of due) {
      scheduledWakeups.delete(key);
    }
    for (const [, wake] of due) {
      if (wake.kind === "terminal") {
        await handleTerminalEvent(wake.event, wake.recoveryEnabled, false);
      } else {
        await run(wake.source);
      }
    }
    rescheduleWakeTimer();
  }

  return {
    request(source: Exclude<WorkboardRecoverySource, "continuation">): Promise<void> {
      cancelWake("recovery:continuation");
      continuationPasses = 0;
      durableContinuationPasses = 0;
      return run(source);
    },

    schedule(source: Exclude<WorkboardRecoverySource, "continuation">, delayMs: number): void {
      scheduleWake(`recovery:${source}`, {
        kind: "recovery",
        source,
        dueAt: Date.now() + Math.max(0, delayMs),
      });
    },

    async handleSubagentEnded(
      event: WorkboardTerminalRunEvent,
      recoveryEnabled: boolean,
    ): Promise<void> {
      if (isRecoverableWorkerInterruption(event.error)) {
        if (recoveryEnabled) {
          await this.request("subagent-ended");
        }
        return;
      }
      await handleTerminalEvent(event, recoveryEnabled, true);
    },
  };
}
