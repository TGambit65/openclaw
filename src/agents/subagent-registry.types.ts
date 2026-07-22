/**
 * Subagent registry record types.
 *
 * Defines execution, completion, delivery, pending-delivery, and attachment state stored for child runs.
 */
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { SubagentRunOutcome } from "./subagent-announce-output.js";
import type { SubagentLifecycleEndedReason } from "./subagent-lifecycle-events.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";

export type PendingFinalDeliveryPayload = {
  /** Durable caller obligation that froze this exact completion payload. */
  obligationId?: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  childSessionKey: string;
  childRunId: string;
  task: string;
  label?: string;
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
  expectsCompletionMessage?: boolean;
  spawnMode?: SpawnSubagentMode;
  frozenResultText?: string | null;
  fallbackFrozenResultText?: string | null;
  wakeOnDescendantSettle?: boolean;
};

export type SubagentExecutionState = {
  status: "running" | "interrupted" | "terminal";
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
  interruptedAt?: number;
  interruptionReason?: "gateway-restart" | "lost-execution-context";
  transcriptFile?: string;
};

export type SubagentCompletionState = {
  required: boolean;
  resultText?: string | null;
  capturedAt?: number;
  fallbackResultText?: string | null;
  fallbackCapturedAt?: number;
};

export type WorkboardVerifiedCompletionProof = {
  id: string;
  status: "passed";
  createdAt: number;
  label?: string;
  command?: string;
  url?: string;
  note?: string;
};

export type WorkboardVerifiedCompletionArtifact = {
  id: string;
  createdAt: number;
  path: string;
  byteSize: number;
  sha256: string;
  verifiedAt: number;
  label?: string;
  url?: string;
  mimeType?: string;
};

/** Immutable, core-owned delivery obligation accepted from the trusted Workboard plugin. */
export type WorkboardVerifiedCompletionIntent = {
  kind: "verified_workboard_completion";
  obligationId: string;
  payloadHash: string;
  acceptedAt: number;
  cardId: string;
  childSessionKey: string;
  runId: string;
  expectedRunId: string;
  expectedRevision: string;
  claimOwnerId: string;
  summary: string;
  completionText: string;
  proof: WorkboardVerifiedCompletionProof;
  artifacts: WorkboardVerifiedCompletionArtifact[];
  createdCardIds: string[];
  flowId: string;
  flowOwnerSessionKey: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  flowRevision: number;
  controllerId: "workboard";
};

export type SubagentCompletionDeliveryState = {
  status:
    | "not_required"
    | "pending"
    | "in_progress"
    | "delivered"
    | "failed"
    | "suspended"
    | "discarded";
  /** Idempotency key supplied by the trusted completion owner. */
  obligationId?: string;
  /** Frozen structured payload whose delivery must survive process restarts. */
  verifiedWorkboardCompletion?: WorkboardVerifiedCompletionIntent;
  payload?: PendingFinalDeliveryPayload;
  createdAt?: number;
  enqueuedAt?: number;
  deliveredAt?: number;
  announcedAt?: number;
  lastAttemptAt?: number;
  attemptCount?: number;
  lastError?: string | null;
  steeringLeaseId?: string;
  steeringLeasedAt?: number;
  steeringInjectedAt?: number;
  suspendedAt?: number;
  suspendedReason?: "retry-limit" | "expiry";
  discardedAt?: number;
  discardReason?: "expired" | "pressure-pruned";
  discardedPayloadSummary?: {
    requesterSessionKey?: string;
    childSessionKey?: string;
    childRunId?: string;
    endedAt?: number;
    status?: string;
    lastError?: string | null;
  };
  lastDropReason?:
    | "queue_cap"
    | "parent_run_ended"
    | "sink_unavailable"
    | "dedupe"
    | "waiting_for_requester_turn";
};

type SubagentKillReconciliationState = {
  /** Actual cancellation time; a yielded run may have an older execution end. */
  killedAt: number;
  /** Requester aborts must not re-inject a delayed completion after queues are cleared. */
  suppressTaskDelivery?: boolean;
  /** Durable ownership boundary even after the newer registry row is released. */
  supersededAt?: number;
};

export type SubagentTaskGenerationRecoveryState = {
  /** Successor run that still needs its own durable task row. */
  runId: string;
  requestedAt: number;
  lastAttemptAt: number;
  attemptCount: number;
  lastError?: string;
};

export type SubagentOrphanRecoveryState = {
  /** Core-owned durable handshake state for one exact predecessor generation. */
  status: "core_owned" | "successor" | "exhausted" | "declined";
  /** Immediate run generation that was interrupted. */
  predecessorRunId: string;
  /** First Workboard run in a restart chain, allowing R1 to resolve directly to R3. */
  rootRunId: string;
  /** Preallocated Gateway run id and idempotency key, or the accepted successor id. */
  successorRunId?: string;
  claimedAt: number;
  updatedAt: number;
  settledAt?: number;
  error?: string;
};

export type SubagentRecoveryOwnershipQuery = {
  childSessionKey: string;
  predecessorRunId: string;
};

export type SubagentRecoveryOwnershipResult =
  | { status: "unknown" }
  | { status: "core_owned"; successorRunId?: string }
  | { status: "successor"; successorRunId: string }
  | { status: "exhausted"; error?: string };

/** Exact, Workboard-only existence query for ambiguous subagent.run responses. */
export type WorkboardSubagentRunStateQuery = {
  childSessionKey: string;
  runId: string;
};

export type WorkboardCompletionDeliveryView = {
  deliveryStatus?: SubagentCompletionDeliveryState["status"];
  deliveredAt?: number;
  deliveryError?: string;
  discardReason?: SubagentCompletionDeliveryState["discardReason"];
  deliveryObligationId?: string;
  verifiedCompletionIntent?: WorkboardVerifiedCompletionIntent;
};

export type WorkboardSubagentRunStateResult = (
  | { status: "unknown" }
  | { status: "absent" }
  | { status: "active" }
  | {
      status: "terminal";
      outcome?: "ok" | "error" | "timeout" | "killed";
      error?: string;
    }
) &
  WorkboardCompletionDeliveryView;

export type WorkboardCompletionDeliveryRequirement = {
  childSessionKey: string;
  runId: string;
  obligationId: string;
  cardId: string;
  expectedRunId: string;
  expectedRevision: string;
  claimOwnerId: string;
  summary: string;
  completionText: string;
  proof: WorkboardVerifiedCompletionProof;
  artifacts: WorkboardVerifiedCompletionArtifact[];
  createdCardIds: string[];
  flowId: string;
  flowOwnerSessionKey: string;
  flowRevision: number;
  controllerId: "workboard";
};

export type WorkboardCompletionDeliveryRequirementResult =
  | {
      status: "armed" | "already_armed" | "delivered";
      deliveryStatus: SubagentCompletionDeliveryState["status"];
      deliveredAt?: number;
      verifiedCompletionIntent: WorkboardVerifiedCompletionIntent;
    }
  | { status: "unknown"; error?: string };

export type SubagentOrphanRecoveryClaimResult =
  | { status: "claimed"; successorRunId: string }
  | { status: "successor"; successorRunId: string }
  | { status: "exhausted" }
  | { status: "unavailable"; error: string };

export type SubagentRunRecord = {
  runId: string;
  /** Detached task owner; steer/restart changes runId but continues the same task. */
  taskRunId?: string;
  /** Durable repair marker when an accepted restart successor lacks its new task row. */
  taskGenerationRecovery?: SubagentTaskGenerationRecoveryState;
  /** Durable ownership handshake for core-vs-plugin restart recovery. */
  orphanRecovery?: SubagentOrphanRecoveryState;
  childSessionKey: string;
  controllerSessionKey?: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  taskName?: string;
  cleanup: "delete" | "keep";
  label?: string;
  model?: string;
  agentDir?: string;
  workspaceDir?: string;
  runTimeoutSeconds?: number;
  spawnMode?: SpawnSubagentMode;
  /** Monotonic ownership generation within one child session. */
  generation?: number;
  createdAt: number;
  startedAt?: number;
  sessionStartedAt?: number;
  accumulatedRuntimeMs?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
  archiveAtMs?: number;
  cleanupCompletedAt?: number;
  cleanupHandled?: boolean;
  suppressAnnounceReason?: "steer-restart" | "killed";
  /** Present only while a current-version killed run awaits bounded reconciliation. */
  killReconciliation?: SubagentKillReconciliationState;
  /** Durable requester-stop policy until silent completion cleanup finishes. */
  suppressCompletionDelivery?: boolean;
  expectsCompletionMessage?: boolean;
  endedReason?: SubagentLifecycleEndedReason;
  pauseReason?: "sessions_yield";
  wakeOnDescendantSettle?: boolean;
  execution?: SubagentExecutionState;
  completion?: SubagentCompletionState;
  /** Set after the subagent_ended hook has been emitted successfully once. */
  endedHookEmittedAt?: number;
  /** Set after cleanupBrowserSessionsForLifecycleEnd has been dispatched once. */
  browserCleanupDispatchedAt?: number;
  /** Set immediately before irreversible sessions.delete cleanup is dispatched. */
  deleteCleanupDispatchedAt?: number;
  /** Durable outbox marker for parent/external completion delivery. */
  delivery?: SubagentCompletionDeliveryState;
  attachmentsDir?: string;
  attachmentsRootDir?: string;
  retainAttachmentsOnKeep?: boolean;
};
