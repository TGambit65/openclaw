/**
 * Post-restart interrupted-run resume for subagent sessions.
 *
 * After a gateway reload aborts in-flight subagent LLM calls, this module scans
 * for interrupted sessions and sends a synthetic resume message to restart
 * their work. Most interrupted sessions have `abortedLastRun: true`; a Gateway
 * WebSocket client can instead persist an exact service-restart close while the
 * child session still says `running`. A hard restart can also leave a durable
 * `lost-execution-context` interruption (or a legacy synthetic terminal error).
 * Parent notification is handled separately by completion delivery after the
 * child reaches a real terminal result.
 *
 * @see https://github.com/openclaw/openclaw/issues/47711
 */

import { randomUUID } from "node:crypto";
import { getRuntimeConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveStorePath,
  updateSessionStore,
  type SessionEntry,
} from "../config/sessions.js";
import { callGateway } from "../gateway/call.js";
import { readSessionMessagesAsync } from "../gateway/session-transcript-readers.js";
import { getAgentRunContext } from "../infra/agent-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { findDetachedTaskRunStrict, startTaskRunByRunId } from "../tasks/detached-task-runtime.js";
import { listTasksForSessionKeyForStatusStrict } from "../tasks/task-status-access.js";
import { resolveInternalSessionEffectsTranscriptPath } from "./internal-session-effects.js";
import {
  evaluateSubagentRecoveryGate,
  markSubagentRecoveryAttempt,
  markSubagentRecoveryWedged,
} from "./subagent-recovery-state.js";
import {
  claimSubagentOrphanRecovery,
  finalizeInterruptedSubagentRun,
  markSubagentOrphanRecoveryDeclined,
  markSubagentOrphanRecoveryExhausted,
  replaceSubagentRunAfterSteer,
} from "./subagent-registry-steer-runtime.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isRestartInterruptedAgentError } from "./subagent-restart-interruption.js";
import { compareSubagentRunGeneration } from "./subagent-run-generation.js";
import { tryCreateRecoveredSubagentTaskGeneration } from "./subagent-task-generation.js";

const log = createSubsystemLogger("subagent-interrupted-resume");

/** Delay before attempting recovery to let the gateway finish bootstrapping. */
const DEFAULT_RECOVERY_DELAY_MS = 5_000;

const LOST_ACTIVE_EXECUTION_CONTEXT_ERROR = "subagent run lost active execution context";
const orphanRecoverySessionClaims = new Set<string>();

type ClaimedOrphanRecovery = {
  predecessorRunId: string;
  childSessionKey: string;
  successorRunId: string;
};

type OrphanRecoveryCandidate = Pick<ClaimedOrphanRecovery, "predecessorRunId" | "childSessionKey">;

function hasVerifiedWorkboardCompletion(run: SubagentRunRecord): boolean {
  return run.delivery?.verifiedWorkboardCompletion !== undefined;
}

function recoveryClaimKey(params: { predecessorRunId: string; childSessionKey: string }): string {
  return `${params.childSessionKey}\u0000${params.predecessorRunId}`;
}

function preclaimLatestOrphanRecoveries(params: {
  activeRuns: Map<string, SubagentRunRecord>;
  onClaim?: (claim: ClaimedOrphanRecovery) => void;
  onCandidate?: (candidate: OrphanRecoveryCandidate) => void;
  onlyInterrupted?: boolean;
}): Map<string, ClaimedOrphanRecovery> {
  const latestRunBySession = new Map<string, SubagentRunRecord>();
  for (const candidate of params.activeRuns.values()) {
    const childSessionKey = candidate.childSessionKey?.trim();
    if (!childSessionKey) {
      continue;
    }
    const latest = latestRunBySession.get(childSessionKey);
    if (!latest || compareSubagentRunGeneration(candidate, latest) > 0) {
      latestRunBySession.set(childSessionKey, candidate);
    }
  }

  const claims = new Map<string, ClaimedOrphanRecovery>();
  const cfg = getRuntimeConfig();
  const stores = new Map<string, Record<string, SessionEntry>>();
  for (const runRecord of latestRunBySession.values()) {
    if (hasVerifiedWorkboardCompletion(runRecord)) {
      continue;
    }
    const predecessorRunId = runRecord.runId.trim();
    const childSessionKey = runRecord.childSessionKey.trim();
    if (!predecessorRunId || !childSessionKey) {
      continue;
    }
    let entry: SessionEntry | undefined;
    try {
      const agentId = resolveAgentIdFromSessionKey(childSessionKey);
      const storePath = resolveStorePath(cfg.session?.store, { agentId });
      let store = stores.get(storePath);
      if (!store) {
        store = loadSessionStore(storePath);
        stores.set(storePath, store);
      }
      entry = store[childSessionKey];
    } catch {
      // An already-owned predecessor must still be retained and exhausted by
      // the scheduler even when session state is temporarily unreadable.
    }
    const alreadyOwned =
      runRecord.orphanRecovery?.status === "core_owned" &&
      runRecord.orphanRecovery.predecessorRunId === runRecord.runId;
    if (
      params.onlyInterrupted === true &&
      !alreadyOwned &&
      !hasCurrentAbortedRunEvidence(runRecord, entry) &&
      !isRestartInterruptedTerminalRun(runRecord, entry) &&
      !isLostExecutionContextInterruptedRun(runRecord, entry) &&
      !hasRestartInterruptedDetachedTaskEvidence(runRecord, entry)
    ) {
      continue;
    }
    params.onCandidate?.({ predecessorRunId, childSessionKey });
    const claimed = claimSubagentOrphanRecovery({
      predecessorRunId,
      childSessionKey,
      successorRunId: randomUUID(),
    });
    if (claimed.status !== "claimed") {
      continue;
    }
    const claim = {
      predecessorRunId,
      childSessionKey,
      successorRunId: claimed.successorRunId,
    };
    claims.set(recoveryClaimKey(claim), claim);
    params.onClaim?.(claim);
  }
  return claims;
}

function hasCurrentAbortedRunEvidence(
  runRecord: SubagentRunRecord,
  entry: SessionEntry | undefined,
): boolean {
  if (entry?.abortedLastRun !== true) {
    return false;
  }
  const runStartedAt = runRecord.startedAt ?? runRecord.createdAt;
  return (
    !Number.isFinite(entry.updatedAt) ||
    !Number.isFinite(runStartedAt) ||
    entry.updatedAt >= runStartedAt
  );
}

function hasRestartInterruptedDetachedTaskEvidence(
  runRecord: SubagentRunRecord,
  entry: SessionEntry | undefined,
): boolean {
  if (entry?.status !== "failed") {
    return false;
  }
  const taskRunId = runRecord.taskRunId?.trim() || runRecord.runId.trim();
  if (!taskRunId) {
    return false;
  }
  try {
    const resolution = findDetachedTaskRunStrict({
      runId: taskRunId,
      runtime: "subagent",
      sessionKey: runRecord.childSessionKey,
      createdAtOrAfter: runRecord.sessionStartedAt ?? runRecord.createdAt,
      allowSessionFallback: false,
    });
    const task = resolution.task;
    return (
      resolution.lookup === "available" &&
      task?.runId === taskRunId &&
      task.runtime === "subagent" &&
      task.childSessionKey === runRecord.childSessionKey &&
      task.status === "failed" &&
      isRestartInterruptedAgentError(task.error)
    );
  } catch {
    return false;
  }
}

function isLostExecutionContextInterruptedRun(
  runRecord: SubagentRunRecord,
  entry: SessionEntry | undefined,
): boolean {
  const sessionCanResume = entry?.status === "running" || entry?.status === "failed";
  if (!sessionCanResume) {
    return false;
  }
  if (
    typeof runRecord.endedAt !== "number" &&
    runRecord.execution?.status === "interrupted" &&
    runRecord.execution.interruptionReason === "lost-execution-context"
  ) {
    return true;
  }
  return (
    entry?.status === "failed" &&
    typeof runRecord.endedAt === "number" &&
    runRecord.endedAt > 0 &&
    runRecord.endedReason === "subagent-error" &&
    runRecord.outcome?.status === "error" &&
    runRecord.outcome.error?.trim() === LOST_ACTIVE_EXECUTION_CONTEXT_ERROR
  );
}

function isRestartInterruptedTerminalRun(
  runRecord: SubagentRunRecord,
  entry: SessionEntry | undefined,
): boolean {
  const outcome = runRecord.outcome;
  const error = outcome?.status === "error" ? (outcome.error ?? "") : "";
  return (
    typeof runRecord.endedAt === "number" &&
    runRecord.endedAt > 0 &&
    ((hasCurrentAbortedRunEvidence(runRecord, entry) &&
      (outcome?.status === "timeout" || isRestartInterruptedAgentError(error))) ||
      (entry?.status === "running" && isRestartInterruptedAgentError(error)) ||
      isLostExecutionContextInterruptedRun(runRecord, entry))
  );
}

function reclassifyRestartInterruptedRun(runRecord: SubagentRunRecord): void {
  const interruptedAt = runRecord.endedAt;
  runRecord.execution = {
    ...runRecord.execution,
    status: "interrupted",
    interruptedAt,
    interruptionReason: "gateway-restart",
    endedAt: undefined,
    outcome: undefined,
  };
  runRecord.endedAt = undefined;
  runRecord.endedReason = undefined;
  runRecord.outcome = undefined;
}

/**
 * Build the resume message for an orphaned subagent.
 */
function buildResumeMessage(task: string, lastHumanMessage?: string): string {
  const maxTaskLen = 2000;
  const truncatedTask = task.length > maxTaskLen ? `${task.slice(0, maxTaskLen)}...` : task;

  let message =
    `[System] Your previous turn was interrupted by a gateway reload. ` +
    `Your original task was:\n\n${truncatedTask}\n\n`;

  if (lastHumanMessage) {
    message += `The last message from the user before the interruption was:\n\n${lastHumanMessage}\n\n`;
  }

  message += `Please continue where you left off.`;
  return message;
}

function extractMessageText(msg: unknown): string | undefined {
  if (!msg || typeof msg !== "object") {
    return undefined;
  }
  const m = msg as Record<string, unknown>;
  if (typeof m.content === "string") {
    return m.content;
  }
  if (Array.isArray(m.content)) {
    const text = m.content
      .filter(
        (c: unknown) =>
          typeof c === "object" &&
          c !== null &&
          (c as Record<string, unknown>).type === "text" &&
          typeof (c as Record<string, unknown>).text === "string",
      )
      .map((c: unknown) => (c as Record<string, string>).text)
      .filter(Boolean)
      .join("\n");
    return text || undefined;
  }
  return undefined;
}

/**
 * Send a resume message to an orphaned subagent session via the gateway agent method.
 */
async function resumeOrphanedSession(params: {
  sessionKey: string;
  task: string;
  lastHumanMessage?: string;
  configChangeHint?: string;
  originalRunId: string;
  originalRun: SubagentRunRecord;
  successorRunId: string;
}): Promise<{ resumed: boolean; skipped?: boolean; error?: string }> {
  let resumeMessage = buildResumeMessage(params.task, params.lastHumanMessage);
  if (params.configChangeHint) {
    resumeMessage += params.configChangeHint;
  }

  let successorTaskAnchored = false;
  let successorTaskRunning = false;

  const replaceAcceptedSuccessor = (): boolean =>
    !hasVerifiedWorkboardCompletion(params.originalRun) &&
    replaceSubagentRunAfterSteer({
      previousRunId: params.originalRunId,
      nextRunId: params.successorRunId,
      fallback: params.originalRun,
      transcriptFile: resolveInternalSessionEffectsTranscriptPath(params.successorRunId),
      createFreshTaskGeneration: true,
      taskGenerationAlreadyCreated: successorTaskRunning,
      requireDurableReplacement: true,
      // Persist the stable original task (not the synthetic resume wrapper) so
      // that any further post-restart redispatch reconstructs the same
      // canonical task. Persisting `resumeMessage` instead would accumulate a
      // wrapped-resume-of-resume cascade across repeated restarts.
      task: params.task,
    });

  const hasAcceptedSuccessorEvidence = (): boolean => {
    const activeContext = getAgentRunContext(params.successorRunId);
    if (activeContext?.sessionKey === params.sessionKey) {
      return true;
    }
    try {
      const resolution = findDetachedTaskRunStrict({
        runId: params.successorRunId,
        runtime: "subagent",
        sessionKey: params.sessionKey,
        createdAtOrAfter: params.originalRun.sessionStartedAt ?? params.originalRun.createdAt,
        allowSessionFallback: false,
      });
      const task = resolution.task;
      if (
        resolution.lookup !== "available" ||
        task?.runId !== params.successorRunId ||
        task.runtime !== "subagent" ||
        task.childSessionKey !== params.sessionKey ||
        task.status !== "running" ||
        (task.label?.trim() ?? "") !== (params.originalRun.label?.trim() ?? "")
      ) {
        return false;
      }
      const sessionTasks = listTasksForSessionKeyForStatusStrict(params.sessionKey).filter(
        (candidate) =>
          candidate.runtime === "subagent" && candidate.childSessionKey === params.sessionKey,
      );
      const exactLatest =
        sessionTasks.filter((candidate) => candidate.runId === params.successorRunId).length ===
          1 && sessionTasks[0]?.runId === params.successorRunId;
      if (exactLatest) {
        successorTaskAnchored = true;
        successorTaskRunning = true;
      }
      return exactLatest;
    } catch {
      return false;
    }
  };

  const prepareSuccessorTaskBeforeDispatch = () => {
    const taskRunId = params.originalRun.taskRunId?.trim() || params.originalRunId;
    const resolution = findDetachedTaskRunStrict({
      runId: taskRunId,
      runtime: "subagent",
      sessionKey: params.sessionKey,
      createdAtOrAfter: params.originalRun.sessionStartedAt ?? params.originalRun.createdAt,
      allowSessionFallback: false,
    });
    if (resolution.lookup !== "available" || !resolution.task) {
      if (params.originalRun.label?.trim() === "plugin:workboard") {
        throw new Error("Workboard recovery requires the exact predecessor task");
      }
      return;
    }
    const creation = tryCreateRecoveredSubagentTaskGeneration({
      entry: params.originalRun,
      runId: params.successorRunId,
      task: params.task,
      startedAt: Date.now(),
      previousTask: resolution.task,
      status: "queued",
    });
    if (!creation.task) {
      throw new Error(`failed to persist recovery dispatch anchor: ${creation.error}`);
    }
    successorTaskAnchored = true;
  };

  const markSuccessorTaskRunning = () => {
    if (!successorTaskAnchored || successorTaskRunning) {
      return;
    }
    const updated = startTaskRunByRunId({
      runId: params.successorRunId,
      runtime: "subagent",
      sessionKey: params.sessionKey,
      startedAt: Date.now(),
      lastEventAt: Date.now(),
    }).filter(
      (task) =>
        task.runId === params.successorRunId &&
        task.runtime === "subagent" &&
        task.childSessionKey === params.sessionKey &&
        task.status === "running",
    );
    if (updated.length !== 1) {
      throw new Error("failed to mark the exact recovery dispatch anchor running");
    }
    successorTaskRunning = true;
  };

  try {
    if (hasVerifiedWorkboardCompletion(params.originalRun)) {
      return { resumed: false, skipped: true };
    }
    // A previous Gateway call may have been accepted even though its response
    // (or our subsequent registry remap) was lost. Exact active/task evidence
    // proves that successor already exists, so reconcile it before considering
    // another invocation with the same idempotency key.
    if (hasAcceptedSuccessorEvidence()) {
      if (replaceAcceptedSuccessor()) {
        log.info(`reconciled previously accepted orphan successor: ${params.sessionKey}`);
        return { resumed: true };
      }
      return { resumed: false, error: "accepted successor durable remap failed" };
    }
    if (hasVerifiedWorkboardCompletion(params.originalRun)) {
      return { resumed: false, skipped: true };
    }
    prepareSuccessorTaskBeforeDispatch();
    await callGateway<{ runId: string }>({
      method: "agent",
      params: {
        message: resumeMessage,
        sessionKey: params.sessionKey,
        idempotencyKey: params.successorRunId,
        deliver: false,
        lane: "subagent",
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: params.originalRun.requesterSessionKey,
          sourceChannel: "internal",
          sourceTool: "subagent_interrupted_resume",
        },
        sessionEffects: "internal",
        suppressPromptPersistence: true,
        ...(params.originalRun.workspaceDir ? { cwd: params.originalRun.workspaceDir } : {}),
      },
      timeoutMs: 10_000,
    });
    markSuccessorTaskRunning();
    const remapped = replaceAcceptedSuccessor();
    if (!remapped) {
      log.warn(
        `resumed orphaned session ${params.sessionKey} but durable remap failed; retaining the predecessor claim for an idempotent retry`,
      );
      return { resumed: false, error: "durable successor remap failed" };
    }
    log.info(`resumed orphaned session: ${params.sessionKey}`);
    return { resumed: true };
  } catch (err) {
    const error = formatErrorMessage(err);
    if (hasAcceptedSuccessorEvidence()) {
      try {
        markSuccessorTaskRunning();
      } catch (markError) {
        return {
          resumed: false,
          error: `${error}; ${formatErrorMessage(markError)}`,
        };
      }
      if (replaceAcceptedSuccessor()) {
        log.info(
          `reconciled accepted orphan successor after response failure: ${params.sessionKey}`,
        );
        return { resumed: true };
      }
      return {
        resumed: false,
        error: `${error}; accepted successor durable remap failed`,
      };
    }
    log.warn(`failed to resume orphaned session ${params.sessionKey}: ${error}`);
    return { resumed: false, error };
  }
}

/**
 * Scan for and resume orphaned subagent sessions after a gateway restart.
 *
 * An orphaned session is one where:
 * 1. It has an active (not ended) entry in the subagent run registry
 * 2. Its session store entry has `abortedLastRun: true`, its terminal run
 *    records an exact restart interruption, or the sweeper durably marked it
 *    `lost-execution-context`
 *
 * For each orphaned session found, we:
 * 1. Clear the `abortedLastRun` flag
 * 2. Send a synthetic resume message to trigger a new LLM turn
 */
export async function recoverOrphanedSubagentSessions(params: {
  getActiveRuns: () => Map<string, SubagentRunRecord>;
  /** Persisted across retries so already-resumed sessions are not resumed again. */
  resumedSessionKeys?: Set<string>;
  /** Internal scheduler hook retaining every durable preclaim across retries. */
  onRecoveryClaim?: (claim: ClaimedOrphanRecovery) => void;
}): Promise<{
  recovered: number;
  failed: number;
  skipped: number;
  failedRuns: Array<{ runId: string; childSessionKey: string; error?: string }>;
  scanError?: string;
}> {
  const result: {
    recovered: number;
    failed: number;
    skipped: number;
    failedRuns: Array<{ runId: string; childSessionKey: string; error?: string }>;
    scanError?: string;
  } = {
    recovered: 0,
    failed: 0,
    skipped: 0,
    failedRuns: [] as Array<{ runId: string; childSessionKey: string; error?: string }>,
  };
  const resumedSessionKeys = params.resumedSessionKeys ?? new Set<string>();
  const configChangePattern = /openclaw\.json|openclaw gateway restart|config\.patch/i;

  try {
    const activeRuns = params.getActiveRuns();
    if (activeRuns.size === 0) {
      return result;
    }

    const recoveryCandidateKeys = new Set<string>();
    const recoveryClaims = preclaimLatestOrphanRecoveries({
      activeRuns,
      onClaim: params.onRecoveryClaim,
      onCandidate: (candidate) => recoveryCandidateKeys.add(recoveryClaimKey(candidate)),
      onlyInterrupted: true,
    });

    const cfg = getRuntimeConfig();
    const storeCache = new Map<string, Record<string, SessionEntry>>();
    const latestRunBySession = new Map<string, SubagentRunRecord>();
    for (const candidate of activeRuns.values()) {
      const childSessionKey = candidate.childSessionKey?.trim();
      if (!childSessionKey) {
        continue;
      }
      const latest = latestRunBySession.get(childSessionKey);
      if (!latest || compareSubagentRunGeneration(candidate, latest) > 0) {
        latestRunBySession.set(childSessionKey, candidate);
      }
    }

    for (const [runId, runRecord] of activeRuns.entries()) {
      const childSessionKey = runRecord.childSessionKey?.trim();
      if (!childSessionKey) {
        continue;
      }
      if (latestRunBySession.get(childSessionKey) !== runRecord) {
        result.skipped++;
        continue;
      }
      if (hasVerifiedWorkboardCompletion(runRecord)) {
        result.skipped++;
        continue;
      }
      const candidateKey = recoveryClaimKey({ predecessorRunId: runId, childSessionKey });
      const recoveryClaim = recoveryClaims.get(candidateKey);
      if (!recoveryClaim) {
        if (!recoveryCandidateKeys.has(candidateKey)) {
          result.skipped++;
          continue;
        }
        result.failed++;
        result.failedRuns.push({
          runId,
          childSessionKey,
          error: "durable recovery ownership unavailable",
        });
        continue;
      }
      const now = Date.now();
      if (resumedSessionKeys.has(childSessionKey)) {
        markSubagentOrphanRecoveryDeclined({
          predecessorRunId: runId,
          childSessionKey,
          error: "recovery already accepted in this scheduler",
        });
        result.skipped++;
        continue;
      }
      const inFlightClaimKey = recoveryClaimKey({ predecessorRunId: runId, childSessionKey });
      if (orphanRecoverySessionClaims.has(inFlightClaimKey)) {
        result.skipped++;
        continue;
      }
      orphanRecoverySessionClaims.add(inFlightClaimKey);

      try {
        const agentId = resolveAgentIdFromSessionKey(childSessionKey);
        const storePath = resolveStorePath(cfg.session?.store, { agentId });

        let store = storeCache.get(storePath);
        if (!store) {
          store = loadSessionStore(storePath);
          storeCache.set(storePath, store);
        }

        const entry = store[childSessionKey];
        if (!entry) {
          if (
            !markSubagentOrphanRecoveryDeclined({
              predecessorRunId: runId,
              childSessionKey,
              error: "subagent session entry is unavailable",
            })
          ) {
            throw new Error("failed to persist declined recovery ownership");
          }
          result.skipped++;
          continue;
        }

        const restartInterruptedTerminalRun = isRestartInterruptedTerminalRun(runRecord, entry);
        const lostExecutionContextRun = isLostExecutionContextInterruptedRun(runRecord, entry);
        const restartInterruptedRun =
          restartInterruptedTerminalRun ||
          lostExecutionContextRun ||
          hasRestartInterruptedDetachedTaskEvidence(runRecord, entry);
        // Terminal child outcomes are immutable. Restart resume only applies to
        // non-terminal interrupted execution or an exact restart-interruption
        // signature; delivery retry handles other terminal child results.
        if (
          typeof runRecord.endedAt === "number" &&
          runRecord.endedAt > 0 &&
          !restartInterruptedTerminalRun
        ) {
          if (
            !markSubagentOrphanRecoveryDeclined({
              predecessorRunId: runId,
              childSessionKey,
              error: "run has a non-restart terminal outcome",
            })
          ) {
            throw new Error("failed to persist declined recovery ownership");
          }
          result.skipped++;
          continue;
        }

        // Check if this session was aborted by the restart
        if (!hasCurrentAbortedRunEvidence(runRecord, entry) && !restartInterruptedRun) {
          if (
            !markSubagentOrphanRecoveryDeclined({
              predecessorRunId: runId,
              childSessionKey,
              error: "run has no current restart interruption evidence",
            })
          ) {
            throw new Error("failed to persist declined recovery ownership");
          }
          result.skipped++;
          continue;
        }

        const recoveryGate = evaluateSubagentRecoveryGate(entry, now);
        if (!recoveryGate.allowed) {
          if (recoveryGate.shouldMarkWedged) {
            try {
              await updateSessionStore(storePath, (currentStore) => {
                const current = currentStore[childSessionKey];
                if (current) {
                  markSubagentRecoveryWedged({
                    entry: current,
                    now,
                    runId,
                    reason: recoveryGate.reason,
                  });
                  currentStore[childSessionKey] = current;
                }
              });
              markSubagentRecoveryWedged({
                entry,
                now,
                runId,
                reason: recoveryGate.reason,
              });
            } catch (err) {
              log.warn(
                `failed to persist wedged subagent recovery marker for ${childSessionKey}: ${String(err)}`,
              );
            }
          }
          log.warn(`skipping orphan recovery for ${childSessionKey}: ${recoveryGate.reason}`);
          if (
            !markSubagentOrphanRecoveryDeclined({
              predecessorRunId: runId,
              childSessionKey,
              error: recoveryGate.reason,
            })
          ) {
            throw new Error("failed to persist declined recovery ownership");
          }
          result.skipped++;
          result.failedRuns.push({
            runId,
            childSessionKey,
            error: recoveryGate.reason,
          });
          continue;
        }

        log.info(`found orphaned subagent session: ${childSessionKey} (run=${runId})`);

        const messages = await readSessionMessagesAsync(
          {
            agentId: resolveAgentIdFromSessionKey(childSessionKey),
            sessionEntry: entry,
            sessionId: entry.sessionId,
            sessionKey: childSessionKey,
            storePath,
          },
          {
            mode: "recent",
            maxMessages: 200,
            maxBytes: 1024 * 1024,
          },
        );
        const lastHumanMessage = [...messages]
          .toReversed()
          .find((msg) => (msg as { role?: unknown } | null)?.role === "user");
        const configChangeDetected = messages.some((msg) => {
          if ((msg as { role?: unknown } | null)?.role !== "assistant") {
            return false;
          }
          const text = extractMessageText(msg);
          return typeof text === "string" && configChangePattern.test(text);
        });

        // Resume the session with the original task context.
        // We intentionally do not clear restart evidence before attempting the
        // resume. If callGateway fails, either the aborted flag or the exact
        // terminal service-restart outcome remains available for another boot.
        const resumeResult = await resumeOrphanedSession({
          sessionKey: childSessionKey,
          task: runRecord.task,
          lastHumanMessage: extractMessageText(lastHumanMessage),
          configChangeHint: configChangeDetected
            ? "\n\n[config changes from your previous run were already applied — do not re-modify openclaw.json or restart the gateway]"
            : undefined,
          originalRunId: runId,
          originalRun: runRecord,
          successorRunId: recoveryClaim.successorRunId,
        });

        if (resumeResult.skipped) {
          result.skipped++;
        } else if (resumeResult.resumed) {
          // Consume terminal restart evidence only after the Gateway accepted
          // the successor run. Until then it must remain intact for retries.
          if (restartInterruptedTerminalRun) {
            reclassifyRestartInterruptedRun(runRecord);
          }
          resumedSessionKeys.add(childSessionKey);
          // Only clear the aborted flag after confirmed successful resume.
          try {
            await updateSessionStore(storePath, (currentStore) => {
              const current = currentStore[childSessionKey];
              if (current) {
                current.abortedLastRun = false;
                markSubagentRecoveryAttempt({
                  entry: current,
                  now: Date.now(),
                  runId,
                  attempt: recoveryGate.nextAttempt,
                });
                current.updatedAt = Date.now();
                currentStore[childSessionKey] = current;
              }
            });
          } catch (err) {
            log.warn(
              `resume succeeded but failed to update session store for ${childSessionKey}: ${String(err)}`,
            );
          }
          result.recovered++;
        } else {
          // Restart evidence stays available so the next restart can retry.
          log.warn(
            `resume failed for ${childSessionKey}; restart evidence preserved for retry on next restart`,
          );
          result.failed++;
          result.failedRuns.push({
            runId,
            childSessionKey,
            error: resumeResult.error,
          });
        }
      } catch (err) {
        const error = formatErrorMessage(err);
        log.warn(`error processing orphaned session ${childSessionKey}: ${error}`);
        result.failed++;
        result.failedRuns.push({
          runId,
          childSessionKey,
          error,
        });
      } finally {
        orphanRecoverySessionClaims.delete(inFlightClaimKey);
      }
    }
  } catch (err) {
    const scanError = formatErrorMessage(err);
    log.warn(`orphan recovery scan failed: ${scanError}`);
    result.scanError = scanError;
    // Ensure retry logic fires for scan-level exceptions.
    if (result.failed === 0) {
      result.failed = 1;
    }
  }

  if (result.recovered > 0 || result.failed > 0) {
    log.info(
      `orphan recovery complete: recovered=${result.recovered} failed=${result.failed} skipped=${result.skipped}`,
    );
  }

  return result;
}

/** Maximum number of retry attempts for orphan recovery. */
const MAX_RECOVERY_RETRIES = 3;
/** Backoff multiplier between retries (exponential). */
const RETRY_BACKOFF_MULTIPLIER = 2;

function buildRecoveryFailureMessage(params: { attempts: number; error?: string }): string {
  const base =
    `Subagent run was interrupted by a gateway restart or connection loss. ` +
    `Automatic recovery failed after ${params.attempts} attempt${params.attempts === 1 ? "" : "s"}. ` +
    `Please retry.`;
  const detail = params.error?.trim();
  if (!detail) {
    return base;
  }
  return `${base} (${detail})`;
}

/**
 * Schedule orphan recovery after a delay, with retry logic.
 * The delay gives the gateway time to fully bootstrap after restart.
 * If recovery fails (e.g. gateway not yet ready), retries with exponential backoff.
 */
export function scheduleOrphanRecovery(params: {
  getActiveRuns: () => Map<string, SubagentRunRecord>;
  delayMs?: number;
  maxRetries?: number;
}): void {
  const initialDelay = params.delayMs ?? DEFAULT_RECOVERY_DELAY_MS;
  const maxRetries = params.maxRetries ?? MAX_RECOVERY_RETRIES;

  const resumedSessionKeys = new Set<string>();
  const scheduledClaims = new Map<string, ClaimedOrphanRecovery>();
  const retainClaim = (claim: ClaimedOrphanRecovery) => {
    scheduledClaims.set(recoveryClaimKey(claim), claim);
  };
  const exhaustClaims = async (args: {
    attempts: number;
    claims: Iterable<ClaimedOrphanRecovery>;
    error?: string;
  }) => {
    const uniqueClaims = new Map<string, ClaimedOrphanRecovery>();
    for (const claim of args.claims) {
      uniqueClaims.set(recoveryClaimKey(claim), claim);
    }
    await Promise.allSettled(
      [...uniqueClaims.values()].map(async (claim) => {
        const failureMessage = buildRecoveryFailureMessage({
          attempts: args.attempts,
          error: args.error,
        });
        // If this durable transition fails, retaining ownership is safer than
        // releasing the predecessor while an accepted Gateway invocation may
        // still exist.
        if (
          !markSubagentOrphanRecoveryExhausted({
            predecessorRunId: claim.predecessorRunId,
            childSessionKey: claim.childSessionKey,
            error: failureMessage,
          })
        ) {
          return;
        }
        await finalizeInterruptedSubagentRun({
          runId: claim.predecessorRunId,
          childSessionKey: claim.childSessionKey,
          error: failureMessage,
        });
      }),
    );
  };

  // Allocate and persist every exact successor/idempotency id synchronously,
  // before the initial timer. Subsequent retries and process restarts reuse it.
  try {
    preclaimLatestOrphanRecoveries({
      activeRuns: params.getActiveRuns(),
      onClaim: retainClaim,
      onlyInterrupted: true,
    });
  } catch (error) {
    log.warn(`failed to preclaim orphan recovery candidates: ${formatErrorMessage(error)}`);
  }

  const attemptRecovery = (attempt: number, delay: number) => {
    setTimeout(() => {
      void recoverOrphanedSubagentSessions({
        ...params,
        resumedSessionKeys,
        onRecoveryClaim: retainClaim,
      })
        .then((result) => {
          if (result.failed > 0 && attempt < maxRetries) {
            const nextDelay = delay * RETRY_BACKOFF_MULTIPLIER;
            log.info(
              `orphan recovery had ${result.failed} failure(s); retrying in ${nextDelay}ms (attempt ${attempt + 1}/${maxRetries})`,
            );
            attemptRecovery(attempt + 1, nextDelay);
            return;
          }
          const attempts = attempt + 1;
          if (result.scanError) {
            void exhaustClaims({
              attempts,
              claims: scheduledClaims.values(),
              error: result.scanError,
            });
            return;
          }
          if (result.failedRuns.length === 0) {
            return;
          }
          void Promise.allSettled(
            result.failedRuns.map(async (run) => {
              const claim = scheduledClaims.get(
                recoveryClaimKey({
                  predecessorRunId: run.runId,
                  childSessionKey: run.childSessionKey,
                }),
              );
              if (!claim) {
                return;
              }
              await exhaustClaims({ attempts, claims: [claim], error: run.error });
            }),
          );
        })
        .catch((err: unknown) => {
          if (attempt < maxRetries) {
            const nextDelay = delay * RETRY_BACKOFF_MULTIPLIER;
            log.warn(
              `scheduled orphan recovery failed: ${String(err)}; retrying in ${nextDelay}ms (attempt ${attempt + 1}/${maxRetries})`,
            );
            attemptRecovery(attempt + 1, nextDelay);
          } else {
            log.warn(
              `scheduled orphan recovery failed after ${maxRetries} retries: ${String(err)}`,
            );
            void exhaustClaims({
              attempts: attempt + 1,
              claims: scheduledClaims.values(),
              error: formatErrorMessage(err),
            });
          }
        });
    }, delay).unref?.();
  };

  attemptRecovery(0, initialDelay);
}
