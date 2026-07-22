/**
 * Subagent registry coordinator.
 *
 * Owns registration, lifecycle, delivery retry, steering, orphan recovery, persistence, and cleanup for child runs.
 */
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute as isAbsolutePath } from "node:path";
import type { cleanupBrowserSessionsForLifecycleEnd } from "../browser-lifecycle-cleanup.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ResolveContextEngineOptions } from "../context-engine/registry.js";
import type { ContextEngine, SubagentEndReason } from "../context-engine/types.js";
import { callGateway } from "../gateway/call.js";
import { getAgentRunContext, onAgentEvent } from "../infra/agent-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  formatAbandonedLivenessError,
  formatBlockedLivenessError,
  isAbandonedLivenessState,
  isBlockedLivenessState,
} from "../shared/agent-liveness.js";
import { createLazyImportLoader, createLazyPromiseLoader } from "../shared/lazy-promise.js";
import { importRuntimeModule } from "../shared/runtime-import.js";
import { SUBAGENT_KILL_TASK_ERROR } from "../tasks/detached-task-runtime-contract.js";
import {
  finalizeTaskRunByRunId,
  findDetachedTaskRun,
  findDetachedTaskRunStrict,
  reconcileVerifiedWorkboardCompletion,
} from "../tasks/detached-task-runtime.js";
import { isProvisionalSubagentKillTask } from "../tasks/task-cancellation-state.js";
import { getTaskFlowByIdForOwner } from "../tasks/task-flow-owner-access.js";
import type { TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { listTasksForSessionKeyForStatusStrict } from "../tasks/task-status-access.js";
import { deliveryContextKey, normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import {
  ackLeasedAgentSteeringItemsFromSubagentRuns,
  leasePendingAgentSteeringItemsFromSubagentRuns,
  prependAgentSteeringPrompt,
  releaseLeasedAgentSteeringItemsFromSubagentRuns,
} from "./agent-steering-queue.js";
import { removeInternalSessionEffectsTranscript } from "./internal-session-effects.js";
import { isAbortedAgentStopReason } from "./run-termination.js";
import type { ensureRuntimePluginsLoaded as ensureRuntimePluginsLoadedFn } from "./runtime-plugins.js";
import { type SubagentRunOutcome, withSubagentOutcomeTiming } from "./subagent-announce-output.js";
import {
  ensureCompletionState,
  ensureDeliveryState,
  getDeliveryAttemptCount,
  getDeliveryLastAttemptAt,
  getDeliveryLastError,
  isDeliverySuspended,
} from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_OUTCOME_KILLED,
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import {
  emitSubagentEndedHookOnce,
  resolveLifecycleOutcomeFromRunOutcome,
} from "./subagent-registry-completion.js";
import {
  ANNOUNCE_EXPIRY_MS,
  capFrozenResultText,
  MAX_ANNOUNCE_RETRY_COUNT,
  PROVISIONAL_KILL_RECONCILIATION_MS,
  reconcileOrphanedRestoredRuns,
  reconcileOrphanedRun,
  resolveAnnounceRetryDelayMs,
  safeRemoveAttachmentsDir,
} from "./subagent-registry-helpers.js";
import { createSubagentRegistryLifecycleController } from "./subagent-registry-lifecycle.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  countActiveDescendantRunsFromRuns,
  countActiveRunsForSessionFromRuns,
  countPendingDescendantRunsExcludingRunFromRuns,
  countPendingDescendantRunsFromRuns,
  getSubagentRunByChildSessionKeyFromRuns,
  isSubagentSessionRunActiveFromRuns,
  listRunsForControllerFromRuns,
  listDescendantRunsForRequesterFromRuns,
  listRunsForRequesterFromRuns,
  resolveRequesterForChildSessionFromRuns,
  shouldIgnorePostCompletionAnnounceForSessionFromRuns,
} from "./subagent-registry-queries.js";
import {
  createSubagentRunManager,
  markSubagentRunPausedAfterYield,
  type RegisterSubagentRunParams,
} from "./subagent-registry-run-manager.js";
import {
  clearSubagentRunsReadCacheForTest,
  getSubagentRunsSnapshotForRead,
  getSubagentRunsSnapshotForReadStrict,
  persistSubagentRunsToDisk,
  persistSubagentRunsToDiskOrThrow,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-state.js";
import { configureSubagentRegistrySteerRuntime } from "./subagent-registry-steer-runtime.js";
import type {
  SubagentOrphanRecoveryClaimResult,
  SubagentRecoveryOwnershipQuery,
  SubagentRecoveryOwnershipResult,
  SubagentRunRecord,
  WorkboardCompletionDeliveryRequirement,
  WorkboardCompletionDeliveryRequirementResult,
  WorkboardSubagentRunStateQuery,
  WorkboardSubagentRunStateResult,
  WorkboardVerifiedCompletionArtifact,
  WorkboardVerifiedCompletionIntent,
  WorkboardVerifiedCompletionProof,
} from "./subagent-registry.types.js";
import { isRestartInterruptedAgentError } from "./subagent-restart-interruption.js";
import { compareSubagentRunGeneration } from "./subagent-run-generation.js";
import {
  resolveSubagentRunDeadlineMs,
  resolveSubagentRunEffectiveEndedAt,
} from "./subagent-run-timeout.js";
import {
  loadSubagentSessionEntry,
  resolveCompletionFromSessionEntry,
  resolveSubagentRunOrphanReason,
  resolveSubagentSessionCompletion,
  resolveSubagentSessionStartedAt,
  type SubagentSessionStoreCache,
} from "./subagent-session-reconciliation.js";
import {
  resolveOwnedSubagentTaskRunId,
  resolveSubagentTaskGenerationRetryDelayMs,
  tryCreateRecoveredSubagentTaskGeneration,
} from "./subagent-task-generation.js";
import { resolveAgentTimeoutMs } from "./timeout.js";

export type {
  SubagentRecoveryOwnershipQuery,
  SubagentRecoveryOwnershipResult,
  SubagentRunRecord,
  WorkboardCompletionDeliveryRequirement,
  WorkboardCompletionDeliveryRequirementResult,
  WorkboardSubagentRunStateQuery,
  WorkboardSubagentRunStateResult,
  WorkboardVerifiedCompletionIntent,
} from "./subagent-registry.types.js";
export {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  resolveSubagentSessionStatus,
} from "./subagent-registry-helpers.js";
const log = createSubsystemLogger("agents/subagent-registry");

type SubagentAnnounceModule = Pick<
  typeof import("./subagent-announce.js"),
  "captureSubagentCompletionReply" | "runSubagentAnnounceFlow"
>;
type BrowserCleanupModule = Pick<
  typeof import("../browser-lifecycle-cleanup.js"),
  "cleanupBrowserSessionsForLifecycleEnd"
>;
type SubagentOrphanRecoveryModule = Pick<
  typeof import("./subagent-orphan-recovery.js"),
  "scheduleOrphanRecovery"
>;

type SubagentRegistryDeps = {
  callGateway: typeof callGateway;
  captureSubagentCompletionReply: SubagentAnnounceModule["captureSubagentCompletionReply"];
  cleanupBrowserSessionsForLifecycleEnd: typeof cleanupBrowserSessionsForLifecycleEnd;
  getSubagentRunsSnapshotForRead: typeof getSubagentRunsSnapshotForRead;
  getSubagentRunsSnapshotForReadStrict: typeof getSubagentRunsSnapshotForReadStrict;
  getRuntimeConfig: typeof getRuntimeConfig;
  onAgentEvent: typeof onAgentEvent;
  persistSubagentRunsToDisk: typeof persistSubagentRunsToDisk;
  persistSubagentRunsToDiskOrThrow: typeof persistSubagentRunsToDiskOrThrow;
  resolveAgentTimeoutMs: typeof resolveAgentTimeoutMs;
  restoreSubagentRunsFromDisk: typeof restoreSubagentRunsFromDisk;
  runSubagentAnnounceFlow: SubagentAnnounceModule["runSubagentAnnounceFlow"];
  loadOrphanRecoveryModule: () => Promise<SubagentOrphanRecoveryModule>;
  ensureContextEnginesInitialized?: () => void;
  ensureRuntimePluginsLoaded?: (
    params: Parameters<typeof ensureRuntimePluginsLoadedFn>[0],
  ) => void | Promise<void>;
  resolveContextEngine?: (
    cfg?: OpenClawConfig,
    options?: ResolveContextEngineOptions,
  ) => Promise<ContextEngine>;
};

const subagentAnnounceLoader = createLazyImportLoader<SubagentAnnounceModule>(
  () => import("./subagent-announce.js"),
);
const browserCleanupLoader = createLazyImportLoader<BrowserCleanupModule>(
  () => import("../browser-lifecycle-cleanup.js"),
);

async function loadSubagentAnnounceModule(): Promise<SubagentAnnounceModule> {
  return await subagentAnnounceLoader.load();
}

async function loadCleanupBrowserSessionsForLifecycleEnd(): Promise<
  BrowserCleanupModule["cleanupBrowserSessionsForLifecycleEnd"]
> {
  return (await browserCleanupLoader.load()).cleanupBrowserSessionsForLifecycleEnd;
}

const defaultSubagentRegistryDeps: SubagentRegistryDeps = {
  callGateway,
  captureSubagentCompletionReply: async (sessionKey, options) =>
    (await loadSubagentAnnounceModule()).captureSubagentCompletionReply(sessionKey, options),
  cleanupBrowserSessionsForLifecycleEnd: async (params) =>
    (await loadCleanupBrowserSessionsForLifecycleEnd())(params),
  getSubagentRunsSnapshotForRead,
  getSubagentRunsSnapshotForReadStrict,
  getRuntimeConfig,
  onAgentEvent,
  persistSubagentRunsToDisk,
  persistSubagentRunsToDiskOrThrow,
  resolveAgentTimeoutMs,
  restoreSubagentRunsFromDisk,
  runSubagentAnnounceFlow: async (params) =>
    (await loadSubagentAnnounceModule()).runSubagentAnnounceFlow(params),
  loadOrphanRecoveryModule: async () => await import("./subagent-orphan-recovery.js"),
};

let subagentRegistryDeps: SubagentRegistryDeps = defaultSubagentRegistryDeps;
type ContextEngineInitModule = Pick<
  {
    ensureContextEnginesInitialized: () => void;
  },
  "ensureContextEnginesInitialized"
>;
type ContextEngineRegistryModule = Pick<
  {
    resolveContextEngine: (
      cfg?: OpenClawConfig,
      options?: ResolveContextEngineOptions,
    ) => Promise<ContextEngine>;
  },
  "resolveContextEngine"
>;
type RuntimePluginsModule = Pick<
  {
    ensureRuntimePluginsLoaded: typeof ensureRuntimePluginsLoadedFn;
  },
  "ensureRuntimePluginsLoaded"
>;

const SUBAGENT_REGISTRY_RUNTIME_SPEC = ["./subagent-registry.runtime", ".js"] as const;

const contextEngineInitLoader = createLazyPromiseLoader(() =>
  importRuntimeModule<ContextEngineInitModule>(import.meta.url, SUBAGENT_REGISTRY_RUNTIME_SPEC),
);
const contextEngineRegistryLoader = createLazyPromiseLoader(() =>
  importRuntimeModule<ContextEngineRegistryModule>(import.meta.url, SUBAGENT_REGISTRY_RUNTIME_SPEC),
);
const runtimePluginsLoader = createLazyPromiseLoader(() =>
  importRuntimeModule<RuntimePluginsModule>(import.meta.url, SUBAGENT_REGISTRY_RUNTIME_SPEC),
);

let sweeper: NodeJS.Timeout | null = null;
const resumeRetryTimers = new Set<ReturnType<typeof setTimeout>>();
let sweepInProgress = false;
let listenerStarted = false;
let listenerStop: (() => void) | null = null;
// Use var to avoid TDZ when init runs across circular imports during bootstrap.
let restoreAttempted = false;
const ORPHAN_RECOVERY_DEBOUNCE_MS = 1_000;
let lastOrphanRecoveryScheduleAt = 0;
const SUBAGENT_ANNOUNCE_TIMEOUT_MS = 120_000;
/**
 * Embedded runs can emit transient lifecycle `error` events while provider/model
 * retry is still in progress. Defer terminal error cleanup briefly so a
 * subsequent lifecycle `start` / `end` can cancel premature failure announces.
 */
const LIFECYCLE_ERROR_RETRY_GRACE_MS = 15_000;
/**
 * Embedded runs can also surface an intermediate lifecycle `end` with
 * `aborted=true` just before the runtime automatically retries the same run.
 * Give that timeout a short grace window so the parent does not get a stale
 * `timed out` completion right before the eventual success.
 */
const LIFECYCLE_TIMEOUT_RETRY_GRACE_MS = 15_000;
/** Absolute TTL for session-mode runs after cleanup completes (no archiveAtMs). */
const SESSION_RUN_TTL_MS = 5 * 60_000; // 5 minutes
/** Absolute TTL for orphaned pendingLifecycleError / pendingLifecycleTimeout entries. */
const PENDING_LIFECYCLE_TERMINAL_TTL_MS = 5 * 60_000; // 5 minutes
/** Grace period before treating a "running" subagent without a live run context as stale. */
const STALE_ACTIVE_SUBAGENT_GRACE_MS = process.env.OPENCLAW_TEST_FAST === "1" ? 1_000 : 60_000;
const SUSPENDED_DELIVERY_CRON_EXPIRY_MS = 2 * 60 * 60_000;
const SUSPENDED_DELIVERY_SUBAGENT_EXPIRY_MS = 6 * 60 * 60_000;
const SUSPENDED_DELIVERY_INTERACTIVE_EXPIRY_MS = 24 * 60 * 60_000;
const SUSPENDED_DELIVERY_SOFT_CAP = 25;
const SUSPENDED_DELIVERY_HARD_CAP = 50;
const SUSPENDED_DELIVERY_PRESSURE_TARGET = 10;

function loadContextEngineInitModule(): Promise<ContextEngineInitModule> {
  return contextEngineInitLoader.load();
}

function loadContextEngineRegistryModule(): Promise<ContextEngineRegistryModule> {
  return contextEngineRegistryLoader.load();
}

function loadRuntimePluginsModule(): Promise<RuntimePluginsModule> {
  return runtimePluginsLoader.load();
}

async function ensureSubagentRegistryPluginRuntimeLoaded(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  allowGatewaySubagentBinding?: boolean;
}) {
  const ensureRuntimePluginsLoaded = subagentRegistryDeps.ensureRuntimePluginsLoaded;
  if (ensureRuntimePluginsLoaded) {
    await ensureRuntimePluginsLoaded(params);
    return;
  }
  (await loadRuntimePluginsModule()).ensureRuntimePluginsLoaded(params);
}

async function resolveSubagentRegistryContextEngine(
  cfg: OpenClawConfig,
  options?: ResolveContextEngineOptions,
) {
  const initModule = await loadContextEngineInitModule();
  const registryModule = await loadContextEngineRegistryModule();
  const ensureContextEnginesInitialized =
    subagentRegistryDeps.ensureContextEnginesInitialized ??
    initModule.ensureContextEnginesInitialized;
  const resolveContextEngine =
    subagentRegistryDeps.resolveContextEngine ?? registryModule.resolveContextEngine;
  ensureContextEnginesInitialized();
  return await resolveContextEngine(cfg, options);
}

function persistSubagentRuns() {
  subagentRegistryDeps.persistSubagentRunsToDisk(subagentRuns);
}

function persistSubagentRunsOrThrow() {
  subagentRegistryDeps.persistSubagentRunsToDiskOrThrow(subagentRuns);
}

function findLatestSubagentRunForSession(
  runs: Iterable<SubagentRunRecord>,
  childSessionKey: string,
): SubagentRunRecord | undefined {
  let latest: SubagentRunRecord | undefined;
  for (const candidate of runs) {
    if (candidate.childSessionKey !== childSessionKey) {
      continue;
    }
    if (!latest || compareSubagentRunGeneration(candidate, latest) > 0) {
      latest = candidate;
    }
  }
  return latest;
}

function normalizeOrphanRecoveryError(error: string | undefined): string | undefined {
  const normalized = error?.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > 1_000 ? `${normalized.slice(0, 1_000)}…` : normalized;
}

function normalizeRequiredWorkboardString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}

function normalizeOptionalWorkboardString(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return normalizeRequiredWorkboardString(value, maxLength);
}

function normalizeVerifiedWorkboardProof(
  proof: WorkboardCompletionDeliveryRequirement["proof"],
): WorkboardVerifiedCompletionProof | undefined {
  const id = normalizeRequiredWorkboardString(proof?.id, 512);
  if (
    !id ||
    proof?.status !== "passed" ||
    !Number.isFinite(proof.createdAt) ||
    proof.createdAt < 0
  ) {
    return undefined;
  }
  return {
    id,
    status: "passed",
    createdAt: proof.createdAt,
    ...(normalizeOptionalWorkboardString(proof.label, 160)
      ? { label: normalizeOptionalWorkboardString(proof.label, 160) }
      : {}),
    ...(normalizeOptionalWorkboardString(proof.command, 1_000)
      ? { command: normalizeOptionalWorkboardString(proof.command, 1_000) }
      : {}),
    ...(normalizeOptionalWorkboardString(proof.url, 2_000)
      ? { url: normalizeOptionalWorkboardString(proof.url, 2_000) }
      : {}),
    ...(normalizeOptionalWorkboardString(proof.note, 2_000)
      ? { note: normalizeOptionalWorkboardString(proof.note, 2_000) }
      : {}),
  };
}

function normalizeVerifiedWorkboardArtifact(
  artifact: WorkboardCompletionDeliveryRequirement["artifacts"][number],
): WorkboardVerifiedCompletionArtifact | undefined {
  const id = normalizeRequiredWorkboardString(artifact?.id, 512);
  const artifactPath = normalizeRequiredWorkboardString(artifact?.path, 2_000);
  const sha256 = normalizeRequiredWorkboardString(artifact?.sha256, 64)?.toLowerCase();
  if (
    !id ||
    !artifactPath ||
    !isAbsolutePath(artifactPath) ||
    !sha256 ||
    !/^[a-f0-9]{64}$/u.test(sha256) ||
    !Number.isSafeInteger(artifact.byteSize) ||
    artifact.byteSize < 0 ||
    !Number.isFinite(artifact.createdAt) ||
    artifact.createdAt < 0 ||
    !Number.isFinite(artifact.verifiedAt) ||
    artifact.verifiedAt < 0
  ) {
    return undefined;
  }
  return {
    id,
    createdAt: artifact.createdAt,
    path: artifactPath,
    byteSize: artifact.byteSize,
    sha256,
    verifiedAt: artifact.verifiedAt,
    ...(normalizeOptionalWorkboardString(artifact.label, 160)
      ? { label: normalizeOptionalWorkboardString(artifact.label, 160) }
      : {}),
    ...(normalizeOptionalWorkboardString(artifact.url, 2_000)
      ? { url: normalizeOptionalWorkboardString(artifact.url, 2_000) }
      : {}),
    ...(normalizeOptionalWorkboardString(artifact.mimeType, 160)
      ? { mimeType: normalizeOptionalWorkboardString(artifact.mimeType, 160) }
      : {}),
  };
}

type WorkboardVerifiedCompletionPayload = Omit<
  WorkboardVerifiedCompletionIntent,
  "acceptedAt" | "payloadHash"
>;

type WorkboardVerifiedCompletionInputPayload = Omit<
  WorkboardVerifiedCompletionPayload,
  "requesterSessionKey" | "requesterOrigin"
>;

function normalizeVerifiedWorkboardRequesterOrigin(
  value: DeliveryContext | undefined,
): DeliveryContext | undefined {
  const normalized = normalizeDeliveryContext(value);
  if (!normalized) {
    return undefined;
  }
  return {
    ...(normalized.channel ? { channel: normalized.channel } : {}),
    ...(normalized.to ? { to: normalized.to } : {}),
    ...(normalized.accountId ? { accountId: normalized.accountId } : {}),
    ...(normalized.threadId !== undefined ? { threadId: normalized.threadId } : {}),
  };
}

function normalizeVerifiedWorkboardCompletionPayload(
  requirement: WorkboardCompletionDeliveryRequirement,
): WorkboardVerifiedCompletionInputPayload | undefined {
  const childSessionKey = normalizeRequiredWorkboardString(requirement.childSessionKey, 1_000);
  const runId = normalizeRequiredWorkboardString(requirement.runId, 512);
  const expectedRunId = normalizeRequiredWorkboardString(requirement.expectedRunId, 512);
  const obligationId = normalizeRequiredWorkboardString(requirement.obligationId, 1_000);
  const cardId = normalizeRequiredWorkboardString(requirement.cardId, 512);
  const expectedRevision = normalizeRequiredWorkboardString(requirement.expectedRevision, 512);
  const claimOwnerId = normalizeRequiredWorkboardString(requirement.claimOwnerId, 512);
  const summary = normalizeRequiredWorkboardString(requirement.summary, 2_000);
  const rawCompletionText = normalizeRequiredWorkboardString(
    requirement.completionText,
    1024 * 1024,
  );
  const flowId = normalizeRequiredWorkboardString(requirement.flowId, 512);
  const flowOwnerSessionKey = normalizeRequiredWorkboardString(
    requirement.flowOwnerSessionKey,
    1_000,
  );
  const proof = normalizeVerifiedWorkboardProof(requirement.proof);
  const artifacts = Array.isArray(requirement.artifacts)
    ? requirement.artifacts.map(normalizeVerifiedWorkboardArtifact)
    : [];
  const createdCardIds = Array.isArray(requirement.createdCardIds)
    ? [
        ...new Set(
          requirement.createdCardIds.map((id) => normalizeRequiredWorkboardString(id, 512)),
        ),
      ]
    : [];
  if (
    !childSessionKey ||
    !runId ||
    !expectedRunId ||
    expectedRunId !== runId ||
    !obligationId ||
    !cardId ||
    !expectedRevision ||
    !claimOwnerId ||
    !summary ||
    !rawCompletionText ||
    !flowId ||
    !flowOwnerSessionKey ||
    requirement.controllerId !== "workboard" ||
    !Number.isSafeInteger(requirement.flowRevision) ||
    requirement.flowRevision < 0 ||
    !proof ||
    artifacts.length === 0 ||
    artifacts.length > 32 ||
    artifacts.some((artifact) => artifact === undefined) ||
    createdCardIds.length > 120 ||
    createdCardIds.some((id) => id === undefined)
  ) {
    return undefined;
  }
  return {
    kind: "verified_workboard_completion",
    obligationId,
    cardId,
    childSessionKey,
    runId,
    expectedRunId,
    expectedRevision,
    claimOwnerId,
    summary,
    completionText: capFrozenResultText(rawCompletionText),
    proof,
    artifacts: artifacts as WorkboardVerifiedCompletionArtifact[],
    createdCardIds: createdCardIds as string[],
    flowId,
    flowOwnerSessionKey,
    flowRevision: requirement.flowRevision,
    controllerId: "workboard",
  };
}

function hashVerifiedWorkboardCompletionPayload(
  payload: WorkboardVerifiedCompletionPayload,
): string {
  // Revisions are optimistic-concurrency hints, not obligation identity. Normal
  // Workboard heartbeat/log and flow transitions can advance them between a
  // committed delivery request, a lost response, and its idempotent retry.
  const {
    expectedRevision: _expectedRevision,
    flowRevision: _flowRevision,
    ...immutablePayload
  } = payload;
  return createHash("sha256").update(JSON.stringify(immutablePayload)).digest("hex");
}

export function claimSubagentOrphanRecovery(params: {
  predecessorRunId: string;
  childSessionKey: string;
  successorRunId: string;
  claimedAt?: number;
}): SubagentOrphanRecoveryClaimResult {
  const predecessorRunId = params.predecessorRunId.trim();
  const childSessionKey = params.childSessionKey.trim();
  const proposedSuccessorRunId = params.successorRunId.trim();
  if (!predecessorRunId || !childSessionKey || !proposedSuccessorRunId) {
    return { status: "unavailable", error: "invalid recovery ownership key" };
  }
  const entry = subagentRuns.get(predecessorRunId);
  if (
    !entry ||
    entry.childSessionKey !== childSessionKey ||
    entry.delivery?.verifiedWorkboardCompletion !== undefined ||
    findLatestSubagentRunForSession(subagentRuns.values(), childSessionKey) !== entry
  ) {
    return { status: "unavailable", error: "recovery predecessor is not the latest run" };
  }
  const current = entry.orphanRecovery;
  if (
    current?.status === "core_owned" &&
    current.predecessorRunId === predecessorRunId &&
    current.successorRunId
  ) {
    return { status: "claimed", successorRunId: current.successorRunId };
  }
  if (
    current?.status === "successor" &&
    current.successorRunId === entry.runId &&
    predecessorRunId !== entry.runId
  ) {
    return { status: "successor", successorRunId: current.successorRunId };
  }
  if (
    (current?.status === "exhausted" || current?.status === "declined") &&
    current.predecessorRunId === predecessorRunId
  ) {
    return { status: "exhausted" };
  }

  const now = params.claimedAt ?? Date.now();
  const previous = entry.orphanRecovery;
  entry.orphanRecovery = {
    status: "core_owned",
    predecessorRunId,
    rootRunId: previous?.rootRunId?.trim() || predecessorRunId,
    successorRunId: proposedSuccessorRunId,
    claimedAt: now,
    updatedAt: now,
  };
  try {
    persistSubagentRunsOrThrow();
  } catch (error) {
    entry.orphanRecovery = previous;
    return {
      status: "unavailable",
      error: `failed to persist recovery ownership: ${formatErrorMessage(error)}`,
    };
  }
  return { status: "claimed", successorRunId: proposedSuccessorRunId };
}

function settleSubagentOrphanRecovery(params: {
  predecessorRunId: string;
  childSessionKey: string;
  status: "exhausted" | "declined";
  error?: string;
  settledAt?: number;
}): boolean {
  const predecessorRunId = params.predecessorRunId.trim();
  const childSessionKey = params.childSessionKey.trim();
  const entry = subagentRuns.get(predecessorRunId);
  if (!entry || entry.childSessionKey !== childSessionKey) {
    return false;
  }
  const current = entry.orphanRecovery;
  if (
    !current ||
    current.status !== "core_owned" ||
    current.predecessorRunId !== predecessorRunId
  ) {
    return current?.status === params.status;
  }
  const settledAt = params.settledAt ?? Date.now();
  entry.orphanRecovery = {
    ...current,
    status: params.status,
    updatedAt: settledAt,
    settledAt,
    error: normalizeOrphanRecoveryError(params.error),
  };
  try {
    persistSubagentRunsOrThrow();
  } catch {
    entry.orphanRecovery = current;
    return false;
  }
  return true;
}

export function markSubagentOrphanRecoveryExhausted(params: {
  predecessorRunId: string;
  childSessionKey: string;
  error?: string;
  settledAt?: number;
}): boolean {
  return settleSubagentOrphanRecovery({ ...params, status: "exhausted" });
}

export function markSubagentOrphanRecoveryDeclined(params: {
  predecessorRunId: string;
  childSessionKey: string;
  error?: string;
  settledAt?: number;
}): boolean {
  return settleSubagentOrphanRecovery({ ...params, status: "declined" });
}

function findSubagentTaskForRunId(params: {
  entry: SubagentRunRecord;
  runId: string;
  allowSessionFallback: boolean;
}) {
  const { entry } = params;
  const nextRunCreatedAt = findNextSubagentRunCreatedAt(entry);
  const generationStartedAt = entry.sessionStartedAt ?? entry.createdAt;
  return findDetachedTaskRun({
    runId: params.runId,
    runtime: "subagent",
    sessionKey: entry.childSessionKey,
    createdAtOrAfter: generationStartedAt,
    createdBefore: nextRunCreatedAt,
    allowSessionFallback: params.allowSessionFallback,
  });
}

function persistPendingTaskGenerationLink(entry: SubagentRunRecord, taskRunId: string): boolean {
  const previousTaskRunId = entry.taskRunId;
  const previousRecovery = entry.taskGenerationRecovery;
  entry.taskRunId = taskRunId;
  entry.taskGenerationRecovery = undefined;
  try {
    persistSubagentRunsOrThrow();
    return true;
  } catch (error) {
    entry.taskRunId = previousTaskRunId;
    entry.taskGenerationRecovery = previousRecovery;
    log.warn("failed to persist repaired subagent task generation link", {
      error,
      runId: entry.runId,
      childSessionKey: entry.childSessionKey,
      taskRunId,
    });
    return false;
  }
}

function recordPendingTaskGenerationFailure(entry: SubagentRunRecord, error: string): void {
  const recovery = entry.taskGenerationRecovery;
  if (!recovery) {
    return;
  }
  const now = Date.now();
  entry.taskGenerationRecovery = {
    ...recovery,
    lastAttemptAt: now,
    attemptCount: Math.min(recovery.attemptCount + 1, Number.MAX_SAFE_INTEGER),
    lastError: error,
  };
  try {
    persistSubagentRuns();
  } catch (persistError) {
    log.warn("failed to persist pending subagent task generation retry", {
      error: persistError,
      runId: entry.runId,
      childSessionKey: entry.childSessionKey,
    });
  }
}

function repairPendingSubagentTaskGeneration(entry: SubagentRunRecord) {
  const recovery = entry.taskGenerationRecovery;
  if (!recovery) {
    return undefined;
  }
  const expectedTask = findSubagentTaskForRunId({
    entry,
    runId: recovery.runId,
    allowSessionFallback: false,
  });
  if (expectedTask.lookup === "available" && expectedTask.task) {
    persistPendingTaskGenerationLink(entry, recovery.runId);
    return expectedTask;
  }

  const now = Date.now();
  const retryDelayMs = resolveSubagentTaskGenerationRetryDelayMs(recovery.attemptCount);
  if (now < recovery.lastAttemptAt + retryDelayMs) {
    return expectedTask;
  }

  const previousTask = entry.taskRunId
    ? findSubagentTaskForRunId({
        entry,
        runId: entry.taskRunId,
        allowSessionFallback: false,
      }).task
    : undefined;
  const creation = tryCreateRecoveredSubagentTaskGeneration({
    entry,
    runId: recovery.runId,
    task: entry.task,
    startedAt: entry.startedAt ?? entry.createdAt,
    previousTask,
  });
  if (creation.task) {
    persistPendingTaskGenerationLink(entry, recovery.runId);
    return { lookup: "available" as const, task: creation.task };
  }
  recordPendingTaskGenerationFailure(entry, creation.error);
  return expectedTask;
}

function findSubagentTaskForRun(entry: SubagentRunRecord) {
  const repairedTask = repairPendingSubagentTaskGeneration(entry);
  if (repairedTask) {
    return repairedTask;
  }
  return findSubagentTaskForRunId({
    entry,
    runId: entry.taskRunId ?? entry.runId,
    // Steer/wake replaces the registry run ID while retaining the original
    // task row. Only those continuations may adopt a session-scoped task.
    allowSessionFallback:
      entry.taskRunId === undefined &&
      typeof entry.sessionStartedAt === "number" &&
      entry.sessionStartedAt < entry.createdAt,
  });
}

function hasRestartInterruptedRunEvidence(entry: SubagentRunRecord): boolean {
  const executionOutcome = entry.execution?.outcome;
  const executionError =
    executionOutcome?.status === "error" ? (executionOutcome.error?.trim() ?? "") : "";
  if (isRestartInterruptedAgentError(executionError)) {
    return true;
  }
  const task = findSubagentTaskForRun(entry).task;
  return task?.status === "failed" && isRestartInterruptedAgentError(task.error);
}

function findNextSubagentRunCreatedAt(entry: SubagentRunRecord): number | undefined {
  let nextCreatedAt = entry.killReconciliation?.supersededAt;
  for (const candidate of subagentRuns.values()) {
    if (
      candidate.runId === entry.runId ||
      candidate.childSessionKey !== entry.childSessionKey ||
      compareSubagentRunGeneration(candidate, entry) <= 0
    ) {
      continue;
    }
    nextCreatedAt = Math.min(nextCreatedAt ?? candidate.createdAt, candidate.createdAt);
  }
  return nextCreatedAt;
}

function resolveCompletionFromTerminalTask(
  task: TaskRecord | undefined,
  entry: SubagentRunRecord,
):
  | {
      startedAt?: number;
      endedAt: number;
      outcome: SubagentRunOutcome;
      reason: SubagentLifecycleEndedReason;
      completionSnapshot: { resultText: string | null; capturedAt: number };
    }
  | undefined {
  if (
    !task ||
    typeof task.endedAt !== "number" ||
    (task.status !== "succeeded" && task.status !== "failed" && task.status !== "timed_out")
  ) {
    return undefined;
  }
  const outcome: SubagentRunOutcome =
    task.status === "succeeded"
      ? { status: "ok" }
      : task.status === "timed_out"
        ? { status: "timeout" }
        : { status: "error", error: task.error };
  return {
    // A steer continuation keeps the original task row but owns a new timeout
    // window. Replay against the current registry generation, not task history.
    startedAt: entry.startedAt ?? task.startedAt,
    endedAt: task.endedAt,
    outcome,
    reason: task.status === "failed" ? SUBAGENT_ENDED_REASON_ERROR : SUBAGENT_ENDED_REASON_COMPLETE,
    completionSnapshot: {
      resultText: task.progressSummary ?? task.terminalSummary ?? null,
      capturedAt: task.endedAt,
    },
  };
}

function preclaimCurrentSubagentOrphanRecoveries(): Array<{
  predecessorRunId: string;
  childSessionKey: string;
}> {
  const latestBySession = new Map<string, SubagentRunRecord>();
  for (const candidate of subagentRuns.values()) {
    const childSessionKey = candidate.childSessionKey.trim();
    if (!childSessionKey) {
      continue;
    }
    const latest = latestBySession.get(childSessionKey);
    if (!latest || compareSubagentRunGeneration(candidate, latest) > 0) {
      latestBySession.set(childSessionKey, candidate);
    }
  }
  const claims: Array<{ predecessorRunId: string; childSessionKey: string }> = [];
  const cfg = subagentRegistryDeps.getRuntimeConfig();
  const storeCache: SubagentSessionStoreCache = new Map();
  for (const candidate of latestBySession.values()) {
    const alreadyOwned =
      candidate.orphanRecovery?.status === "core_owned" &&
      candidate.orphanRecovery.predecessorRunId === candidate.runId;
    let abortedByRestart = false;
    try {
      const sessionEntry = loadSubagentSessionEntry({
        childSessionKey: candidate.childSessionKey,
        cfg,
        storeCache,
      });
      const runStartedAt = candidate.startedAt ?? candidate.createdAt;
      abortedByRestart =
        sessionEntry?.abortedLastRun === true &&
        (!Number.isFinite(sessionEntry.updatedAt) ||
          !Number.isFinite(runStartedAt) ||
          sessionEntry.updatedAt >= runStartedAt);
    } catch {
      // Retain an existing durable claim below; otherwise the recovery module
      // will retry candidate discovery once session state is readable.
    }
    const interruptedExecution =
      candidate.execution?.status === "interrupted" &&
      (candidate.execution.interruptionReason === "gateway-restart" ||
        candidate.execution.interruptionReason === "lost-execution-context");
    if (
      !alreadyOwned &&
      !abortedByRestart &&
      !interruptedExecution &&
      !hasRestartInterruptedRunEvidence(candidate)
    ) {
      continue;
    }
    const claimed = claimSubagentOrphanRecovery({
      predecessorRunId: candidate.runId,
      childSessionKey: candidate.childSessionKey,
      successorRunId: randomUUID(),
    });
    if (claimed.status === "claimed") {
      claims.push({
        predecessorRunId: candidate.runId,
        childSessionKey: candidate.childSessionKey,
      });
    }
  }
  return claims;
}

export function scheduleSubagentOrphanRecovery(params?: { delayMs?: number; maxRetries?: number }) {
  // The loader itself can fail during a cold boot. Persist ownership first so
  // that such a failure has an exact state to exhaust instead of silently
  // abandoning an unowned interrupted run.
  const preclaimed = preclaimCurrentSubagentOrphanRecoveries();
  const now = Date.now();
  if (now - lastOrphanRecoveryScheduleAt < ORPHAN_RECOVERY_DEBOUNCE_MS) {
    return;
  }
  lastOrphanRecoveryScheduleAt = now;
  void subagentRegistryDeps.loadOrphanRecoveryModule().then(
    ({ scheduleOrphanRecovery }) => {
      scheduleOrphanRecovery({
        getActiveRuns: () => subagentRuns,
        delayMs: params?.delayMs,
        maxRetries: params?.maxRetries,
      });
    },
    (error: unknown) => {
      const failure = `orphan recovery module unavailable: ${formatErrorMessage(error)}`;
      for (const claim of preclaimed) {
        if (
          markSubagentOrphanRecoveryExhausted({
            ...claim,
            error: failure,
          })
        ) {
          void finalizeInterruptedSubagentRun({
            runId: claim.predecessorRunId,
            childSessionKey: claim.childSessionKey,
            error: failure,
          });
        }
      }
    },
  );
}

const resumedRuns = new Set<string>();
const endedHookInFlightRunIds = new Set<string>();
const pendingLifecycleErrorByRunId = new Map<
  string,
  {
    timer: NodeJS.Timeout;
    endedAt: number;
    startedAt?: number;
    error?: string;
  }
>();
const pendingLifecycleTimeoutByRunId = new Map<
  string,
  {
    timer: NodeJS.Timeout;
    endedAt: number;
    startedAt?: number;
  }
>();

function clearPendingLifecycleError(runId: string) {
  const pending = pendingLifecycleErrorByRunId.get(runId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingLifecycleErrorByRunId.delete(runId);
}

function clearAllPendingLifecycleErrors() {
  for (const pending of pendingLifecycleErrorByRunId.values()) {
    clearTimeout(pending.timer);
  }
  pendingLifecycleErrorByRunId.clear();
}

function clearPendingLifecycleTimeout(runId: string) {
  const pending = pendingLifecycleTimeoutByRunId.get(runId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingLifecycleTimeoutByRunId.delete(runId);
}

function clearAllPendingLifecycleTimeouts() {
  for (const pending of pendingLifecycleTimeoutByRunId.values()) {
    clearTimeout(pending.timer);
  }
  pendingLifecycleTimeoutByRunId.clear();
}

type CompleteSubagentRunParams = {
  runId: string;
  endedAt?: number;
  outcome: SubagentRunOutcome;
  reason: SubagentLifecycleEndedReason;
  sendFarewell?: boolean;
  accountId?: string;
  triggerCleanup: boolean;
  startedAt?: number;
  suppressSessionEffects?: boolean;
};

async function completeSubagentRunWithRecovery(params: CompleteSubagentRunParams, source: string) {
  try {
    await completeSubagentRun(params);
    return;
  } catch (error) {
    const current = subagentRuns.get(params.runId);
    log.warn("failed to complete subagent run; retrying completion", {
      source,
      runId: params.runId,
      childSessionKey: current?.childSessionKey,
      error,
    });
  }

  const current = subagentRuns.get(params.runId);
  if (!current) {
    return;
  }

  try {
    await completeSubagentRun(params);
    return;
  } catch (retryError) {
    log.warn("failed to complete subagent run after retry; retrying ended cleanup", {
      source,
      runId: params.runId,
      childSessionKey: current.childSessionKey,
      error: retryError,
    });
  }

  const latest = subagentRuns.get(params.runId);
  if (latest && typeof latest.endedAt !== "number") {
    // The durable write rolled the in-memory entry back. Preserve the original
    // completion through the normal persisted-session recovery path.
    scheduleSubagentOrphanRecovery({ delayMs: 1_000 });
    return;
  }
  if (
    !latest ||
    typeof latest.endedAt !== "number" ||
    typeof latest.cleanupCompletedAt === "number" ||
    latest.pauseReason === "sessions_yield"
  ) {
    return;
  }
  latest.cleanupHandled = false;
  resumedRuns.delete(params.runId);
  resumeSubagentRun(params.runId);
}

function completeSubagentRunInBackground(params: CompleteSubagentRunParams, source: string) {
  void completeSubagentRunWithRecovery(params, source);
}

function schedulePendingLifecycleError(params: {
  runId: string;
  endedAt: number;
  startedAt?: number;
  error?: string;
}) {
  clearPendingLifecycleTimeout(params.runId);
  clearPendingLifecycleError(params.runId);
  const timer = setTimeout(() => {
    const pending = pendingLifecycleErrorByRunId.get(params.runId);
    if (!pending || pending.timer !== timer) {
      return;
    }
    pendingLifecycleErrorByRunId.delete(params.runId);
    const entry = subagentRuns.get(params.runId);
    if (!entry) {
      return;
    }
    if (entry.endedReason === SUBAGENT_ENDED_REASON_COMPLETE || entry.outcome?.status === "ok") {
      return;
    }
    const completionParams = {
      runId: params.runId,
      endedAt: pending.endedAt,
      outcome: {
        status: "error" as const,
        error: pending.error,
      },
      reason: SUBAGENT_ENDED_REASON_ERROR,
      sendFarewell: true,
      accountId: entry.requesterOrigin?.accountId,
      triggerCleanup: true,
      startedAt: pending.startedAt,
    };
    completeSubagentRunInBackground(completionParams, "lifecycle-error-grace");
  }, LIFECYCLE_ERROR_RETRY_GRACE_MS);
  timer.unref?.();
  pendingLifecycleErrorByRunId.set(params.runId, {
    timer,
    endedAt: params.endedAt,
    startedAt: params.startedAt,
    error: params.error,
  });
}

function schedulePendingLifecycleTimeout(params: {
  runId: string;
  endedAt: number;
  startedAt?: number;
}) {
  clearPendingLifecycleError(params.runId);
  clearPendingLifecycleTimeout(params.runId);
  const timer = setTimeout(() => {
    const pending = pendingLifecycleTimeoutByRunId.get(params.runId);
    if (!pending || pending.timer !== timer) {
      return;
    }
    pendingLifecycleTimeoutByRunId.delete(params.runId);
    const entry = subagentRuns.get(params.runId);
    if (!entry) {
      return;
    }
    if (entry.outcome?.status === "ok" || entry.pauseReason === "sessions_yield") {
      return;
    }
    const completionParams = {
      runId: params.runId,
      endedAt: pending.endedAt,
      outcome: {
        status: "timeout" as const,
      },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      sendFarewell: true,
      accountId: entry.requesterOrigin?.accountId,
      triggerCleanup: true,
      startedAt: pending.startedAt,
    };
    completeSubagentRunInBackground(completionParams, "lifecycle-timeout-grace");
  }, LIFECYCLE_TIMEOUT_RETRY_GRACE_MS);
  timer.unref?.();
  pendingLifecycleTimeoutByRunId.set(params.runId, {
    timer,
    endedAt: params.endedAt,
    startedAt: params.startedAt,
  });
}

async function notifyContextEngineSubagentEnded(params: {
  childSessionKey: string;
  reason: SubagentEndReason;
  agentDir?: string;
  workspaceDir?: string;
}) {
  try {
    const cfg = subagentRegistryDeps.getRuntimeConfig();
    await ensureSubagentRegistryPluginRuntimeLoaded({
      config: cfg,
      workspaceDir: params.workspaceDir,
      allowGatewaySubagentBinding: true,
    });
    const engine = await resolveSubagentRegistryContextEngine(cfg, {
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
    });
    if (!engine.onSubagentEnded) {
      return;
    }
    await engine.onSubagentEnded(params);
  } catch (err) {
    log.warn("context-engine onSubagentEnded failed (best-effort)", { err });
  }
}

function suppressAnnounceForSteerRestart(entry?: SubagentRunRecord) {
  return entry?.suppressAnnounceReason === "steer-restart";
}

function shouldKeepThreadBindingAfterRun(params: {
  entry: SubagentRunRecord;
  reason: SubagentLifecycleEndedReason;
}) {
  if (params.reason === SUBAGENT_ENDED_REASON_KILLED) {
    return false;
  }
  return params.entry.spawnMode === "session";
}

function shouldEmitEndedHookForRun(params: {
  entry: SubagentRunRecord;
  reason: SubagentLifecycleEndedReason;
}) {
  return !shouldKeepThreadBindingAfterRun(params);
}

async function emitSubagentEndedHookForRun(params: {
  entry: SubagentRunRecord;
  reason?: SubagentLifecycleEndedReason;
  sendFarewell?: boolean;
  accountId?: string;
  isCurrent?: () => boolean;
}) {
  if (params.entry.endedHookEmittedAt) {
    return;
  }
  const cfg = subagentRegistryDeps.getRuntimeConfig();
  await ensureSubagentRegistryPluginRuntimeLoaded({
    config: cfg,
    workspaceDir: params.entry.workspaceDir,
    allowGatewaySubagentBinding: true,
  });
  if (params.entry.endedHookEmittedAt || params.isCurrent?.() === false) {
    return;
  }
  // Plugin loading yields after the terminal lock is released. Resolve the
  // event from the canonical row only after that boundary so an older callback
  // cannot claim the exactly-once hook with a superseded timeout or error.
  const reason = params.entry.endedReason ?? params.reason ?? SUBAGENT_ENDED_REASON_COMPLETE;
  const outcome =
    reason === SUBAGENT_ENDED_REASON_KILLED
      ? SUBAGENT_ENDED_OUTCOME_KILLED
      : resolveLifecycleOutcomeFromRunOutcome(params.entry.outcome);
  const error = params.entry.outcome?.status === "error" ? params.entry.outcome.error : undefined;
  await emitSubagentEndedHookOnce({
    entry: params.entry,
    reason,
    sendFarewell: params.sendFarewell,
    accountId: params.accountId ?? params.entry.requesterOrigin?.accountId,
    outcome,
    error,
    inFlightRunIds: endedHookInFlightRunIds,
    persist: persistSubagentRuns,
  });
}

const subagentLifecycleController = createSubagentRegistryLifecycleController({
  runs: subagentRuns,
  resumedRuns,
  subagentAnnounceTimeoutMs: SUBAGENT_ANNOUNCE_TIMEOUT_MS,
  persist: persistSubagentRuns,
  persistOrThrow: persistSubagentRunsOrThrow,
  clearPendingLifecycleError,
  countPendingDescendantRuns,
  suppressAnnounceForSteerRestart,
  resolveSubagentTask: findSubagentTaskForRun,
  shouldEmitEndedHookForRun,
  emitSubagentEndedHookForRun,
  notifyContextEngineSubagentEnded,
  retireSupersededRun: retireSupersededSubagentRun,
  resumeSubagentRun,
  callGateway: (request) => subagentRegistryDeps.callGateway(request),
  captureSubagentCompletionReply: (sessionKey, options) =>
    subagentRegistryDeps.captureSubagentCompletionReply(sessionKey, options),
  cleanupBrowserSessionsForLifecycleEnd: (args) =>
    subagentRegistryDeps.cleanupBrowserSessionsForLifecycleEnd(args),
  runSubagentAnnounceFlow: (params) => subagentRegistryDeps.runSubagentAnnounceFlow(params),
  warn: (message, meta) => log.warn(message, meta),
});

const {
  clearScheduledResumeTimers,
  completeCleanupBookkeeping,
  completeSubagentRun,
  finalizeResumedAnnounceGiveUp,
  refreshFrozenResultFromSession,
  startSubagentAnnounceCleanupFlow,
} = subagentLifecycleController;

function resumeSubagentRun(runId: string) {
  if (!runId || resumedRuns.has(runId)) {
    return;
  }
  const entry = subagentRuns.get(runId);
  if (!entry) {
    return;
  }
  if (entry.cleanupCompletedAt) {
    return;
  }
  if (typeof entry.endedAt === "number" && isDeliverySuspended(entry)) {
    if (!entry.delivery?.verifiedWorkboardCompletion) {
      return;
    }
    rearmSuspendedVerifiedWorkboardDelivery(entry);
    persistSubagentRuns();
  }
  // Yielded runs stay paused until explicitly steered, except orchestrators
  // waiting on descendants: their settle retry must reach the wake path.
  if (entry.pauseReason === "sessions_yield" && entry.wakeOnDescendantSettle !== true) {
    return;
  }
  // Skip entries that have exhausted their retry budget or expired (#18264).
  if (getDeliveryAttemptCount(entry) >= MAX_ANNOUNCE_RETRY_COUNT) {
    void finalizeResumedAnnounceGiveUp({
      runId,
      entry,
      reason: "retry-limit",
    });
    return;
  }
  if (
    entry.expectsCompletionMessage !== true &&
    typeof entry.endedAt === "number" &&
    Date.now() - entry.endedAt > ANNOUNCE_EXPIRY_MS
  ) {
    void finalizeResumedAnnounceGiveUp({
      runId,
      entry,
      reason: "expiry",
    });
    return;
  }

  const now = Date.now();
  const lastAttemptAt = getDeliveryLastAttemptAt(entry);
  const delayMs = resolveAnnounceRetryDelayMs(getDeliveryAttemptCount(entry));
  const earliestRetryAt = (lastAttemptAt ?? 0) + delayMs;
  if (entry.expectsCompletionMessage === true && lastAttemptAt && now < earliestRetryAt) {
    const waitMs = Math.max(1, earliestRetryAt - now);
    const scheduledEntry = entry;
    const timer = setTimeout(() => {
      resumeRetryTimers.delete(timer);
      if (subagentRuns.get(runId) !== scheduledEntry) {
        return;
      }
      resumedRuns.delete(runId);
      resumeSubagentRun(runId);
    }, waitMs);
    timer.unref?.();
    resumeRetryTimers.add(timer);
    resumedRuns.add(runId);
    return;
  }

  if (typeof entry.endedAt === "number" && entry.endedAt > 0) {
    if (entry.killReconciliation) {
      // Restored kills remain reconciliation tombstones; only the sweeper may
      // accept late provider completion or stabilize their task cancellation.
      resumedRuns.add(runId);
      return;
    }
    const orphanReason = resolveSubagentRunOrphanReason({ entry });
    if (orphanReason) {
      if (
        reconcileOrphanedRun({
          runId,
          entry,
          reason: orphanReason,
          source: "resume",
          runs: subagentRuns,
          resumedRuns,
        })
      ) {
        persistSubagentRuns();
      }
      return;
    }
    if (suppressAnnounceForSteerRestart(entry)) {
      resumedRuns.add(runId);
      return;
    }
    if (!startSubagentAnnounceCleanupFlow(runId, entry)) {
      return;
    }
    resumedRuns.add(runId);
    return;
  }

  // Wait for completion again after restart.
  const cfg = subagentRegistryDeps.getRuntimeConfig();
  const waitTimeoutMs = resolveSubagentWaitTimeoutMs(cfg, entry.runTimeoutSeconds);
  void subagentRunManager.waitForSubagentCompletion(runId, waitTimeoutMs, entry, true);
  resumedRuns.add(runId);
}

function restoreSubagentRunsOnce() {
  if (restoreAttempted) {
    return;
  }
  restoreAttempted = true;
  try {
    const restoredCount = subagentRegistryDeps.restoreSubagentRunsFromDisk({
      runs: subagentRuns,
      mergeOnly: true,
    });
    if (restoredCount === 0) {
      return;
    }
    if (
      reconcileOrphanedRestoredRuns({
        runs: subagentRuns,
        resumedRuns,
      })
    ) {
      persistSubagentRuns();
    }
    if (subagentRuns.size === 0) {
      return;
    }
    // Resume pending work.
    ensureListener();
    // Always start sweeper — session-mode runs (no archiveAtMs) also need TTL cleanup.
    startSweeper();
    for (const runId of subagentRuns.keys()) {
      const restored = subagentRuns.get(runId);
      if (restored?.delivery?.verifiedWorkboardCompletion) {
        if (
          typeof restored.endedAt !== "number" &&
          getAgentRunContext(restored.runId)?.sessionKey !== restored.childSessionKey
        ) {
          finalizeVerifiedWorkboardCompletionState(restored);
        }
        reconcileVerifiedWorkboardTaskProjection(restored);
      }
      resumeSubagentRun(runId);
    }

    // Cold-start restore path: queue the same recovery pass that restart
    // startup also uses so resumed children are handled through one seam.
    scheduleSubagentOrphanRecovery();
  } catch (err) {
    log.warn(
      `failed to restore subagent runs from disk: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function resolveSubagentWaitTimeoutMs(cfg: OpenClawConfig, runTimeoutSeconds?: number) {
  return subagentRegistryDeps.resolveAgentTimeoutMs({
    cfg,
    overrideSeconds: runTimeoutSeconds ?? 0,
  });
}

function startSweeper() {
  if (sweeper) {
    return;
  }
  sweeper = setInterval(() => {
    if (sweepInProgress) {
      return;
    }
    void runSubagentSweep();
  }, 60_000);
  sweeper.unref?.();
}

async function runSubagentSweep() {
  try {
    await sweepSubagentRuns();
  } catch (err) {
    log.warn(`subagent run sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function stopSweeper() {
  if (!sweeper) {
    return;
  }
  clearInterval(sweeper);
  sweeper = null;
}

function isSuspendedPendingFinalDelivery(entry: SubagentRunRecord): boolean {
  return typeof entry.endedAt === "number" && isDeliverySuspended(entry);
}

function resolveSuspendedDeliveryExpiryMs(entry: SubagentRunRecord): number {
  const requester = entry.requesterSessionKey;
  if (requester.includes(":cron:")) {
    return SUSPENDED_DELIVERY_CRON_EXPIRY_MS;
  }
  if (requester.includes(":subagent:")) {
    return SUSPENDED_DELIVERY_SUBAGENT_EXPIRY_MS;
  }
  return SUSPENDED_DELIVERY_INTERACTIVE_EXPIRY_MS;
}

async function discardSuspendedPendingFinalDelivery(
  runId: string,
  entry: SubagentRunRecord,
  now: number,
  reason: "expired" | "pressure-pruned",
): Promise<void> {
  const delivery = ensureDeliveryState(entry);
  const payload = delivery.payload;
  delivery.status = "discarded";
  delivery.discardedAt = now;
  delivery.discardReason = reason;
  delivery.discardedPayloadSummary = {
    requesterSessionKey: payload?.requesterSessionKey ?? entry.requesterSessionKey,
    childSessionKey: payload?.childSessionKey ?? entry.childSessionKey,
    childRunId: payload?.childRunId ?? entry.runId,
    endedAt: payload?.endedAt ?? entry.endedAt,
    status: payload?.outcome?.status ?? entry.outcome?.status,
    lastError: getDeliveryLastError(entry) ?? null,
  };
  delivery.payload = undefined;
  delivery.createdAt = undefined;
  delivery.lastAttemptAt = undefined;
  delivery.attemptCount = undefined;
  delivery.lastError = undefined;
  delivery.suspendedAt = undefined;
  delivery.suspendedReason = undefined;
  entry.wakeOnDescendantSettle = undefined;
  const completion = ensureCompletionState(entry);
  completion.fallbackResultText = undefined;
  completion.fallbackCapturedAt = undefined;
  entry.cleanupHandled = true;
  delivery.announcedAt = undefined;
  resumedRuns.delete(runId);
  clearPendingLifecycleError(runId);
  clearPendingLifecycleTimeout(runId);
  log.warn("subagent suspended delivery discarded", {
    reason,
    runId: entry.runId,
    childSessionKey: entry.childSessionKey,
    requesterSessionKey: entry.requesterSessionKey,
  });
  const shouldDeleteAttachments = entry.cleanup === "delete" || !entry.retainAttachmentsOnKeep;
  if (shouldDeleteAttachments) {
    await safeRemoveAttachmentsDir(entry);
  }
  await removeInternalSessionEffectsTranscript(entry.execution?.transcriptFile);
  const completionReason = entry.endedReason ?? SUBAGENT_ENDED_REASON_COMPLETE;
  completeCleanupBookkeeping({
    runId,
    entry,
    cleanup: entry.cleanup,
    completedAt: now,
  });
  if (
    entry.expectsCompletionMessage === true &&
    shouldEmitEndedHookForRun({
      entry,
      reason: completionReason,
    })
  ) {
    await emitSubagentEndedHookForRun({
      entry,
      reason: completionReason,
      sendFarewell: true,
    });
  }
}

async function retireSupersededSubagentRun(runId: string, entry: SubagentRunRecord): Promise<void> {
  const transcriptFile = entry.execution?.transcriptFile;
  clearPendingLifecycleError(runId);
  subagentRuns.delete(runId);
  const transcriptStillOwned = Array.from(subagentRuns.values()).some(
    (candidate) => candidate.execution?.transcriptFile === transcriptFile,
  );
  if (transcriptFile && !transcriptStillOwned) {
    await removeInternalSessionEffectsTranscript(transcriptFile);
  }
  if (entry.cleanup === "delete" || !entry.retainAttachmentsOnKeep) {
    await safeRemoveAttachmentsDir(entry);
  }
}

async function sweepSubagentRuns() {
  if (sweepInProgress) {
    return;
  }
  sweepInProgress = true;
  try {
    const now = Date.now();
    const storeCache: SubagentSessionStoreCache = new Map();
    let mutated = false;
    const suspendedEntries = [...subagentRuns.entries()].filter(([, entry]) =>
      isSuspendedPendingFinalDelivery(entry),
    );
    const pressureDiscardRunIds = new Set<string>();
    if (suspendedEntries.length > SUSPENDED_DELIVERY_HARD_CAP) {
      const pressureCount = Math.max(
        0,
        suspendedEntries.length - SUSPENDED_DELIVERY_PRESSURE_TARGET,
      );
      for (const [runId] of suspendedEntries
        .toSorted((a, b) => (a[1].delivery?.suspendedAt ?? 0) - (b[1].delivery?.suspendedAt ?? 0))
        .slice(0, pressureCount)) {
        pressureDiscardRunIds.add(runId);
      }
      log.warn("subagent suspended delivery backlog exceeded pressure cap", {
        suspendedCount: suspendedEntries.length,
        softCap: SUSPENDED_DELIVERY_SOFT_CAP,
        hardCap: SUSPENDED_DELIVERY_HARD_CAP,
        pressureTarget: SUSPENDED_DELIVERY_PRESSURE_TARGET,
        pressureDiscardCount: pressureDiscardRunIds.size,
      });
    }
    for (const [runId, entry] of subagentRuns.entries()) {
      // Replacement starts this sweeper, and cold-start restore restarts it.
      // Retry a missing successor task row even while the Gateway run remains
      // active; the repair helper enforces its own capped backoff.
      if (entry.taskGenerationRecovery) {
        findSubagentTaskForRun(entry);
      }
      if (isSuspendedPendingFinalDelivery(entry)) {
        const suspendedAgeMs = now - (entry.delivery?.suspendedAt ?? now);
        const expired = suspendedAgeMs >= resolveSuspendedDeliveryExpiryMs(entry);
        if (expired || pressureDiscardRunIds.has(runId)) {
          await discardSuspendedPendingFinalDelivery(
            runId,
            entry,
            now,
            expired ? "expired" : "pressure-pruned",
          );
          mutated = true;
        }
        continue;
      }
      if (typeof entry.endedAt !== "number") {
        const hasLiveRunContext = Boolean(getAgentRunContext(runId));
        const activeAgeMs = now - (entry.startedAt ?? entry.createdAt);
        if (!hasLiveRunContext && activeAgeMs >= STALE_ACTIVE_SUBAGENT_GRACE_MS) {
          const orphanReason = resolveSubagentRunOrphanReason({
            entry,
          });
          if (orphanReason) {
            if (
              reconcileOrphanedRun({
                runId,
                entry,
                reason: orphanReason,
                source: "resume",
                runs: subagentRuns,
                resumedRuns,
              })
            ) {
              mutated = true;
            }
            continue;
          }

          const sessionEntry = loadSubagentSessionEntry({
            childSessionKey: entry.childSessionKey,
            storeCache,
          });
          const failedSessionHasRestartEvidence =
            sessionEntry?.status === "failed" && hasRestartInterruptedRunEvidence(entry);
          const completion = failedSessionHasRestartEvidence
            ? null
            : resolveCompletionFromSessionEntry(sessionEntry, now, {
                notBeforeMs: entry.startedAt ?? entry.createdAt,
              });
          if (completion) {
            await completeSubagentRunWithRecovery(
              {
                runId,
                startedAt: completion.startedAt,
                endedAt: completion.endedAt,
                outcome: completion.outcome,
                reason: completion.reason,
                sendFarewell: true,
                accountId: entry.requesterOrigin?.accountId,
                triggerCleanup: true,
              },
              "sweeper-session-completion",
            );
            continue;
          }

          if (sessionEntry?.abortedLastRun === true) {
            scheduleSubagentOrphanRecovery({ delayMs: 1_000 });
            continue;
          }

          const sessionCanResume =
            sessionEntry?.status === "running" || failedSessionHasRestartEvidence;
          if (sessionCanResume) {
            entry.execution = {
              ...entry.execution,
              status: "interrupted",
              interruptedAt: now,
              interruptionReason: "lost-execution-context",
              endedAt: undefined,
              outcome: undefined,
            };
            mutated = true;
            scheduleSubagentOrphanRecovery({ delayMs: 1_000 });
            continue;
          }

          await completeSubagentRunWithRecovery(
            {
              runId,
              endedAt: now,
              outcome: {
                status: "error",
                error: "subagent run lost active execution context",
              },
              reason: SUBAGENT_ENDED_REASON_ERROR,
              sendFarewell: true,
              accountId: entry.requesterOrigin?.accountId,
              triggerCleanup: true,
            },
            "sweeper-lost-context",
          );
          continue;
        }
      }

      if (entry.killReconciliation) {
        const killReconciliation = entry.killReconciliation;
        const taskResolutionBeforeReconciliation = findSubagentTaskForRun(entry);
        const taskBeforeReconciliation = taskResolutionBeforeReconciliation.task;
        const nextRunCreatedAt = findNextSubagentRunCreatedAt(entry);
        const hasStableTaskCancellation =
          taskBeforeReconciliation?.status === "cancelled" &&
          !isProvisionalSubagentKillTask(taskBeforeReconciliation);
        const killedAt = killReconciliation.killedAt;
        const taskCompletion =
          nextRunCreatedAt === undefined
            ? resolveCompletionFromTerminalTask(taskBeforeReconciliation, entry)
            : undefined;
        if (taskCompletion) {
          // Provider reconciliation commits the non-publishing task ledger first.
          // If the registry write was interrupted, replay that durable projection
          // before the provisional kill can age into a contradictory cancellation.
          await completeSubagentRunWithRecovery(
            {
              runId,
              ...taskCompletion,
              sendFarewell: true,
              accountId: entry.requesterOrigin?.accountId,
              triggerCleanup: true,
            },
            "sweeper-provisional-kill-task-completion",
          );
          const current = subagentRuns.get(runId);
          if (current !== entry || current.killReconciliation !== killReconciliation) {
            continue;
          }
          // A failed registry retry must preserve the replayable task evidence.
          continue;
        }
        const reconcileAtMs = killedAt + PROVISIONAL_KILL_RECONCILIATION_MS;
        if (reconcileAtMs > now) {
          // Even durable cancellation keeps the evidence window open: a
          // provider result persisted before killedAt remains canonical.
          continue;
        }
        const sessionEntry = loadSubagentSessionEntry({
          childSessionKey: entry.childSessionKey,
          storeCache,
        });
        const completion = resolveCompletionFromSessionEntry(sessionEntry, now, {
          notBeforeMs: entry.startedAt ?? entry.createdAt,
        });
        const completionEndedAt = completion
          ? resolveSubagentRunEffectiveEndedAt(entry, completion.endedAt, completion.startedAt)
          : undefined;
        const completionDeadline = completion
          ? resolveSubagentRunDeadlineMs(entry, completion.startedAt)
          : undefined;
        const killedSnapshotExpiredDeadline =
          completion?.reason === SUBAGENT_ENDED_REASON_KILLED &&
          completionDeadline !== undefined &&
          completion.endedAt > completionDeadline
            ? completionDeadline
            : undefined;
        const completionCanOverrideCancellation =
          !hasStableTaskCancellation || (completionEndedAt ?? Number.POSITIVE_INFINITY) < killedAt;
        const completionBelongsToGeneration =
          nextRunCreatedAt === undefined ||
          (completion != null && completion.endedAt < nextRunCreatedAt);
        if (
          completion &&
          completionEndedAt !== undefined &&
          completionCanOverrideCancellation &&
          completionBelongsToGeneration &&
          (completion.reason !== SUBAGENT_ENDED_REASON_KILLED ||
            killedSnapshotExpiredDeadline !== undefined)
        ) {
          const hasNewerGeneration = nextRunCreatedAt !== undefined;
          await completeSubagentRunWithRecovery(
            {
              runId,
              startedAt: completion.startedAt,
              endedAt: killedSnapshotExpiredDeadline ?? completion.endedAt,
              outcome:
                killedSnapshotExpiredDeadline !== undefined
                  ? { status: "timeout" }
                  : completion.outcome,
              reason:
                killedSnapshotExpiredDeadline !== undefined
                  ? SUBAGENT_ENDED_REASON_COMPLETE
                  : completion.reason,
              sendFarewell: true,
              accountId: entry.requesterOrigin?.accountId,
              triggerCleanup: !hasNewerGeneration,
              suppressSessionEffects: hasNewerGeneration,
            },
            "sweeper-provisional-kill-completion",
          );
          if (
            hasNewerGeneration &&
            subagentRuns.get(runId) === entry &&
            entry.endedReason !== SUBAGENT_ENDED_REASON_KILLED
          ) {
            await retireSupersededSubagentRun(runId, entry);
            mutated = true;
            continue;
          }
          if (
            subagentRuns.get(runId) !== entry ||
            entry.endedReason !== SUBAGENT_ENDED_REASON_KILLED ||
            entry.killReconciliation !== killReconciliation
          ) {
            continue;
          }
          const taskResolutionAfterCompletion = findSubagentTaskForRun(entry);
          const taskAfterCompletion = taskResolutionAfterCompletion.task;
          const stableCancellationWonDuringCompletion =
            taskAfterCompletion?.status === "cancelled" &&
            !isProvisionalSubagentKillTask(taskAfterCompletion) &&
            completionEndedAt >= killedAt;
          if (
            !stableCancellationWonDuringCompletion &&
            taskResolutionAfterCompletion.lookup !== "unavailable"
          ) {
            // The attempted completion did not commit. Keep both durable
            // sources unless a newer stable cancellation won during capture.
            continue;
          }
        }
        // Completion capture yields. Revalidate both owners before promoting a
        // provisional marker into a sticky operator cancellation.
        if (
          subagentRuns.get(runId) !== entry ||
          entry.endedReason !== SUBAGENT_ENDED_REASON_KILLED ||
          entry.killReconciliation !== killReconciliation
        ) {
          continue;
        }
        const taskResolutionBefore = findSubagentTaskForRun(entry);
        const taskBefore = taskResolutionBefore.task;
        const stableTaskCancellationAfterReconciliation =
          taskBefore?.status === "cancelled" && !isProvisionalSubagentKillTask(taskBefore);
        const taskNeedsStabilization =
          taskResolutionBefore.lookup === "unavailable" ||
          (taskBefore !== undefined &&
            (taskBefore.status === "queued" ||
              taskBefore.status === "running" ||
              isProvisionalSubagentKillTask(taskBefore)));
        if (taskNeedsStabilization) {
          const observedError =
            entry.outcome?.status === "error" ? entry.outcome.error?.trim() : undefined;
          try {
            // The live callback may be lost across restart. Make the provisional
            // task state stable before its last reconciliation record is deleted.
            const finalizedTasks = finalizeTaskRunByRunId({
              runId: taskBefore?.runId ?? resolveOwnedSubagentTaskRunId(entry),
              runtime: "subagent",
              sessionKey: taskBefore?.childSessionKey ?? entry.childSessionKey,
              status: "cancelled",
              endedAt: killedAt,
              lastEventAt: killedAt,
              error:
                observedError && observedError !== SUBAGENT_KILL_TASK_ERROR
                  ? observedError
                  : "Subagent run cancellation finalized.",
              suppressDelivery: true,
            });
            if (finalizedTasks.length === 0) {
              const taskAfterResolution = findSubagentTaskForRun(entry);
              const taskAfter = taskAfterResolution.task;
              if (
                taskAfterResolution.lookup === "available" &&
                taskAfter !== undefined &&
                (taskAfter.status === "queued" ||
                  taskAfter.status === "running" ||
                  isProvisionalSubagentKillTask(taskAfter))
              ) {
                log.warn("killed task was not stabilized during sweep", {
                  runId,
                  childSessionKey: entry.childSessionKey,
                });
                continue;
              }
              if (taskAfterResolution.lookup === "unavailable") {
                // Legacy custom runtimes cannot distinguish missing from
                // opaque task state. After the bounded window and one finalizer
                // attempt, do not leak the registry/session tombstone forever.
                log.warn("retiring killed tombstone after opaque task finalization", {
                  runId,
                  childSessionKey: entry.childSessionKey,
                });
              }
            }
          } catch (error) {
            log.warn("failed to finalize provisional killed task during sweep", {
              error,
              runId,
              childSessionKey: entry.childSessionKey,
            });
            continue;
          }
        }
        if (findNextSubagentRunCreatedAt(entry) !== undefined) {
          // A newer generation owns this session key. Retire only the old run;
          // session-scoped hooks or context cleanup would tear down the live owner.
          await retireSupersededSubagentRun(runId, entry);
          mutated = true;
          continue;
        }
        // Re-enter the normal cleanup owner only after cancellation is canonical.
        // It publishes the final failure once, then applies keep/delete semantics.
        entry.suppressCompletionDelivery =
          killReconciliation.suppressTaskDelivery === true ||
          hasStableTaskCancellation ||
          stableTaskCancellationAfterReconciliation
            ? true
            : undefined;
        entry.suppressAnnounceReason = undefined;
        entry.killReconciliation = undefined;
        entry.cleanupHandled = false;
        entry.cleanupCompletedAt = undefined;
        mutated = true;
        startSubagentAnnounceCleanupFlow(runId, entry);
        continue;
      }
      if (!entry.archiveAtMs && entry.cleanup === "keep" && entry.spawnMode !== "session") {
        continue;
      }
      if (!entry.archiveAtMs) {
        if (
          typeof entry.cleanupCompletedAt === "number" &&
          now - entry.cleanupCompletedAt > SESSION_RUN_TTL_MS
        ) {
          clearPendingLifecycleError(runId);
          void notifyContextEngineSubagentEnded({
            childSessionKey: entry.childSessionKey,
            reason: "swept",
            agentDir: entry.agentDir,
            workspaceDir: entry.workspaceDir,
          });
          subagentRuns.delete(runId);
          mutated = true;
          if (!entry.retainAttachmentsOnKeep) {
            await safeRemoveAttachmentsDir(entry);
          }
        }
        continue;
      }
      if (entry.archiveAtMs > now) {
        continue;
      }
      clearPendingLifecycleError(runId);
      try {
        await subagentRegistryDeps.callGateway({
          method: "sessions.delete",
          params: {
            key: entry.childSessionKey,
            deleteTranscript: true,
            emitLifecycleHooks: false,
          },
          timeoutMs: 10_000,
        });
      } catch (err) {
        log.warn("sessions.delete failed during subagent sweep; keeping run for retry", {
          runId,
          childSessionKey: entry.childSessionKey,
          err,
        });
        continue;
      }
      subagentRuns.delete(runId);
      mutated = true;
      // Archive/purge is terminal for the run record; remove any retained attachments too.
      await safeRemoveAttachmentsDir(entry);
      void notifyContextEngineSubagentEnded({
        childSessionKey: entry.childSessionKey,
        reason: "swept",
        agentDir: entry.agentDir,
        workspaceDir: entry.workspaceDir,
      });
    }
    // Sweep orphaned pendingLifecycleError entries (absolute TTL).
    for (const [runId, pending] of pendingLifecycleErrorByRunId.entries()) {
      if (now - pending.endedAt > PENDING_LIFECYCLE_TERMINAL_TTL_MS) {
        clearPendingLifecycleError(runId);
      }
    }
    for (const [runId, pending] of pendingLifecycleTimeoutByRunId.entries()) {
      if (now - pending.endedAt > PENDING_LIFECYCLE_TERMINAL_TTL_MS) {
        clearPendingLifecycleTimeout(runId);
      }
    }

    if (mutated) {
      persistSubagentRuns();
    }
    if (subagentRuns.size === 0) {
      stopSweeper();
    }
  } finally {
    sweepInProgress = false;
  }
}

function ensureListener() {
  if (listenerStarted) {
    return;
  }
  listenerStarted = true;
  listenerStop = subagentRegistryDeps.onAgentEvent((evt) => {
    void (async () => {
      if (!evt || evt.stream !== "lifecycle") {
        return;
      }
      const phase = evt.data?.phase;
      const entry = subagentRuns.get(evt.runId);
      if (!entry) {
        if (phase === "end" && typeof evt.sessionKey === "string") {
          await refreshFrozenResultFromSession(evt.sessionKey);
        }
        return;
      }
      if (phase === "start") {
        clearPendingLifecycleError(evt.runId);
        clearPendingLifecycleTimeout(evt.runId);
        const startedAt = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : undefined;
        if (startedAt) {
          entry.startedAt = startedAt;
          if (typeof entry.sessionStartedAt !== "number") {
            entry.sessionStartedAt = startedAt;
          }
          persistSubagentRuns();
        }
        return;
      }
      if (phase !== "end" && phase !== "error") {
        return;
      }
      const endedAt = typeof evt.data?.endedAt === "number" ? evt.data.endedAt : Date.now();
      const startedAt = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : undefined;
      const error = typeof evt.data?.error === "string" ? evt.data.error : undefined;
      const livenessState =
        typeof evt.data?.livenessState === "string" ? evt.data.livenessState : undefined;
      const stopReason = typeof evt.data?.stopReason === "string" ? evt.data.stopReason : undefined;
      // sessions_yield ends the turn by aborting the run signal, so a yielded
      // terminal can also look aborted. An explicit yield is authoritative — pause,
      // don't kill — else the tracking task settles `cancelled` with a false notice (#92448).
      if (evt.data?.yielded === true) {
        // Drop any grace timer from an earlier aborted/error terminal so it can't
        // later fire and settle this now-paused run with a false notice.
        clearPendingLifecycleError(evt.runId);
        clearPendingLifecycleTimeout(evt.runId);
        if (
          markSubagentRunPausedAfterYield({
            entry,
            endedAt,
            startedAt: startedAt ?? entry.startedAt,
          })
        ) {
          persistSubagentRuns();
        }
        return;
      }
      if (isAbortedAgentStopReason(stopReason)) {
        clearPendingLifecycleError(evt.runId);
        clearPendingLifecycleTimeout(evt.runId);
        await completeSubagentRunWithRecovery(
          {
            runId: evt.runId,
            endedAt,
            outcome: {
              status: "error",
              error: "subagent run terminated",
            },
            reason: SUBAGENT_ENDED_REASON_KILLED,
            sendFarewell: true,
            accountId: entry.requesterOrigin?.accountId,
            triggerCleanup: true,
            startedAt,
          },
          "lifecycle-killed-event",
        );
        return;
      }
      if (phase === "error") {
        schedulePendingLifecycleError({
          runId: evt.runId,
          endedAt,
          startedAt,
          error,
        });
        return;
      }
      const blocked = isBlockedLivenessState(livenessState);
      const abandoned = isAbandonedLivenessState(livenessState);
      if (blocked || abandoned) {
        clearPendingLifecycleError(evt.runId);
        clearPendingLifecycleTimeout(evt.runId);
        const blockedParams = {
          runId: evt.runId,
          endedAt,
          outcome: {
            status: "error" as const,
            error: blocked
              ? formatBlockedLivenessError(error)
              : formatAbandonedLivenessError(error),
          },
          reason: SUBAGENT_ENDED_REASON_ERROR,
          sendFarewell: true,
          accountId: entry.requesterOrigin?.accountId,
          triggerCleanup: true,
          startedAt,
        };
        await completeSubagentRunWithRecovery(
          blockedParams,
          blocked ? "lifecycle-blocked-event" : "lifecycle-abandoned-event",
        );
        return;
      }
      if (evt.data?.aborted) {
        schedulePendingLifecycleTimeout({
          runId: evt.runId,
          endedAt,
          startedAt,
        });
        return;
      }
      clearPendingLifecycleError(evt.runId);
      clearPendingLifecycleTimeout(evt.runId);
      const completionParams = {
        runId: evt.runId,
        endedAt,
        outcome: { status: "ok" as const },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        sendFarewell: true,
        accountId: entry.requesterOrigin?.accountId,
        triggerCleanup: true,
        startedAt,
      };
      await completeSubagentRunWithRecovery(completionParams, "lifecycle-ok-event");
    })().catch((err: unknown) => {
      log.warn("lifecycle event handler failed", { err, runId: evt.runId });
    });
  });
}

const subagentRunManager = createSubagentRunManager({
  runs: subagentRuns,
  resumedRuns,
  persist: persistSubagentRuns,
  persistOrThrow: persistSubagentRunsOrThrow,
  callGateway: (request) => subagentRegistryDeps.callGateway(request),
  getRuntimeConfig: () => subagentRegistryDeps.getRuntimeConfig(),
  ensureListener,
  startSweeper,
  stopSweeper,
  resumeSubagentRun,
  clearPendingLifecycleError,
  clearPendingLifecycleTimeout,
  resolveSubagentWaitTimeoutMs,
  scheduleOrphanRecovery: (args) => scheduleSubagentOrphanRecovery(args),
  resolveSubagentSessionCompletion,
  resolveSubagentSessionStartedAt,
  notifyContextEngineSubagentEnded,
  completeCleanupBookkeeping,
  completeSubagentRun,
  resolveSubagentTask: findSubagentTaskForRun,
});

configureSubagentRegistrySteerRuntime({
  replaceSubagentRunAfterSteer: (params) => subagentRunManager.replaceSubagentRunAfterSteer(params),
  finalizeInterruptedSubagentRun: async (params) => await finalizeInterruptedSubagentRun(params),
  claimSubagentOrphanRecovery,
  markSubagentOrphanRecoveryDeclined,
  markSubagentOrphanRecoveryExhausted,
});

export function markSubagentRunForSteerRestart(runId: string) {
  return subagentRunManager.markSubagentRunForSteerRestart(runId);
}

export function clearSubagentRunSteerRestart(runId: string) {
  return subagentRunManager.clearSubagentRunSteerRestart(runId);
}

export function replaceSubagentRunAfterSteer(params: {
  previousRunId: string;
  nextRunId: string;
  fallback?: SubagentRunRecord;
  runTimeoutSeconds?: number;
  preserveFrozenResultFallback?: boolean;
  requireDurableReplacement?: boolean;
  createFreshTaskGeneration?: boolean;
  taskGenerationAlreadyCreated?: boolean;
  transcriptFile?: string;
  task?: string;
}) {
  return subagentRunManager.replaceSubagentRunAfterSteer(params);
}

export function registerSubagentRun(params: RegisterSubagentRunParams) {
  return subagentRunManager.registerSubagentRun(params);
}

export function resetSubagentRegistryForTests(opts?: { persist?: boolean }) {
  clearScheduledResumeTimers();
  for (const timer of resumeRetryTimers) {
    clearTimeout(timer);
  }
  resumeRetryTimers.clear();
  subagentRuns.clear();
  resumedRuns.clear();
  endedHookInFlightRunIds.clear();
  clearAllPendingLifecycleErrors();
  clearAllPendingLifecycleTimeouts();
  contextEngineInitLoader.clear();
  contextEngineRegistryLoader.clear();
  runtimePluginsLoader.clear();
  subagentAnnounceLoader.clear();
  browserCleanupLoader.clear();
  clearSubagentRunsReadCacheForTest();
  stopSweeper();
  sweepInProgress = false;
  restoreAttempted = false;
  lastOrphanRecoveryScheduleAt = 0;
  if (listenerStop) {
    listenerStop();
    listenerStop = null;
  }
  listenerStarted = false;
  if (opts?.persist !== false) {
    persistSubagentRuns();
  }
}

export const testing = {
  async sweepOnceForTests() {
    await sweepSubagentRuns();
  },
  async runSweeperTickForTests() {
    await runSubagentSweep();
  },
  async refreshFrozenResultFromSessionForTests(sessionKey: string) {
    return await refreshFrozenResultFromSession(sessionKey);
  },
  setDepsForTest(overrides?: Partial<SubagentRegistryDeps>) {
    subagentRegistryDeps = overrides
      ? {
          ...defaultSubagentRegistryDeps,
          ...overrides,
        }
      : defaultSubagentRegistryDeps;
  },
} as const;

export function addSubagentRunForTests(entry: SubagentRunRecord) {
  subagentRuns.set(entry.runId, entry);
}

export function releaseSubagentRun(runId: string) {
  subagentRunManager.releaseSubagentRun(runId);
}

export async function finalizeInterruptedSubagentRun(params: {
  runId?: string;
  childSessionKey?: string;
  error: string;
  endedAt?: number;
}): Promise<number> {
  const runIds = new Set<string>();
  if (typeof params.runId === "string" && params.runId.trim()) {
    runIds.add(params.runId.trim());
  }
  if (typeof params.childSessionKey === "string" && params.childSessionKey.trim()) {
    const childSessionKey = params.childSessionKey.trim();
    for (const [runId, entry] of subagentRuns.entries()) {
      if (entry.childSessionKey === childSessionKey) {
        runIds.add(runId);
      }
    }
  }
  if (runIds.size === 0) {
    return 0;
  }

  const endedAt =
    typeof params.endedAt === "number" && Number.isFinite(params.endedAt)
      ? params.endedAt
      : Date.now();
  let updated = 0;
  for (const runId of runIds) {
    clearPendingLifecycleError(runId);
    clearPendingLifecycleTimeout(runId);
    const entry = subagentRuns.get(runId);
    if (!entry || typeof entry.cleanupCompletedAt === "number") {
      continue;
    }
    await completeSubagentRunWithRecovery(
      {
        runId,
        endedAt,
        outcome: {
          status: "error",
          error: params.error,
        },
        reason: SUBAGENT_ENDED_REASON_ERROR,
        sendFarewell: true,
        accountId: entry.requesterOrigin?.accountId,
        triggerCleanup: true,
      },
      "explicit-failed-mark",
    );
    updated += 1;
  }
  return updated;
}

export function resolveRequesterForChildSession(childSessionKey: string): {
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
} | null {
  const runsSnapshot = subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns);
  const resolved = resolveRequesterForChildSessionFromRuns(runsSnapshot, childSessionKey);
  if (resolved === null) {
    return null;
  }
  const requesterOrigin = normalizeDeliveryContext(resolved.requesterOrigin);
  return {
    requesterSessionKey: resolved.requesterSessionKey,
    requesterOrigin,
  };
}

function resolveWorkboardCompletionDeliveryView(
  entry: SubagentRunRecord | undefined,
): Pick<
  WorkboardSubagentRunStateResult,
  | "deliveryStatus"
  | "deliveredAt"
  | "deliveryError"
  | "discardReason"
  | "deliveryObligationId"
  | "verifiedCompletionIntent"
> {
  const delivery = entry?.delivery;
  if (!delivery) {
    return {};
  }
  const intent = delivery.verifiedWorkboardCompletion;
  return {
    deliveryStatus: delivery.status,
    ...(typeof delivery.deliveredAt === "number" ? { deliveredAt: delivery.deliveredAt } : {}),
    ...(normalizeOrphanRecoveryError(delivery.lastError ?? undefined)
      ? { deliveryError: normalizeOrphanRecoveryError(delivery.lastError ?? undefined) }
      : {}),
    ...(delivery.discardReason ? { discardReason: delivery.discardReason } : {}),
    ...(delivery.obligationId || intent?.obligationId
      ? { deliveryObligationId: delivery.obligationId ?? intent?.obligationId }
      : {}),
    ...(intent ? { verifiedCompletionIntent: structuredClone(intent) } : {}),
  };
}

function buildWorkboardCompletionDeliveryResult(
  status: "armed" | "already_armed" | "delivered",
  entry: SubagentRunRecord,
  intent: WorkboardVerifiedCompletionIntent,
): WorkboardCompletionDeliveryRequirementResult {
  const delivery = entry.delivery;
  return {
    status,
    deliveryStatus: delivery?.status ?? "pending",
    ...(typeof delivery?.deliveredAt === "number" ? { deliveredAt: delivery.deliveredAt } : {}),
    verifiedCompletionIntent: structuredClone(intent),
  };
}

function isExactWorkboardCompletionTaskLink(params: {
  entry: SubagentRunRecord;
  task: TaskRecord | undefined;
  flowId: string;
  ownerSessionKey: string;
}): params is typeof params & { task: TaskRecord } {
  const task = params.task;
  return Boolean(
    task &&
    task.runtime === "subagent" &&
    task.runId === params.entry.runId &&
    task.childSessionKey === params.entry.childSessionKey &&
    task.ownerKey === params.ownerSessionKey &&
    task.parentFlowId === params.flowId &&
    task.label?.trim() === "plugin:workboard",
  );
}

function resolveActiveWorkboardCompletionLink(
  entry: SubagentRunRecord,
  payload: WorkboardVerifiedCompletionInputPayload,
): { task: TaskRecord; flow: TaskFlowRecord } | undefined {
  const taskResolution = findSubagentTaskForRun(entry);
  if (
    taskResolution.lookup !== "available" ||
    !isExactWorkboardCompletionTaskLink({
      entry,
      task: taskResolution.task,
      flowId: payload.flowId,
      ownerSessionKey: payload.flowOwnerSessionKey,
    })
  ) {
    return undefined;
  }
  const flow = getTaskFlowByIdForOwner({
    flowId: payload.flowId,
    callerOwnerKey: payload.flowOwnerSessionKey,
  });
  if (
    !flow ||
    flow.syncMode !== "managed" ||
    flow.controllerId !== "workboard" ||
    // Workboard records a managed wait with a blocked summary as `blocked`.
    // The exact task/run wait is still non-terminal and completion-capable.
    (flow.status !== "queued" &&
      flow.status !== "running" &&
      flow.status !== "waiting" &&
      flow.status !== "blocked") ||
    flow.cancelRequestedAt != null
  ) {
    return undefined;
  }
  return { task: taskResolution.task!, flow };
}

/**
 * Proves that an interrupted requester still has an exact Workboard-owned
 * durable completion route. Main-session recovery uses this only to suppress
 * its generic interruption notice; the Workboard controller remains the sole
 * owner of eventual success/failure delivery.
 */
export function hasDurableWorkboardCompletionOwnerForRequester(
  requesterSessionKey: string,
): boolean {
  const ownerSessionKey = requesterSessionKey.trim();
  if (!ownerSessionKey) {
    return false;
  }
  restoreSubagentRunsOnce();
  let snapshot: Map<string, SubagentRunRecord>;
  try {
    snapshot = subagentRegistryDeps.getSubagentRunsSnapshotForReadStrict(subagentRuns);
  } catch {
    return false;
  }
  for (const entry of snapshot.values()) {
    const controllerSessionKey =
      entry.controllerSessionKey?.trim() || entry.requesterSessionKey.trim();
    if (
      entry.requesterSessionKey !== ownerSessionKey ||
      controllerSessionKey !== ownerSessionKey ||
      entry.label?.trim() !== "plugin:workboard" ||
      entry.cleanup !== "keep" ||
      findLatestSubagentRunForSession(snapshot.values(), entry.childSessionKey) !== entry
    ) {
      continue;
    }
    try {
      const taskResolution = findSubagentTaskForRun(entry);
      const task = taskResolution.lookup === "available" ? taskResolution.task : undefined;
      const flowId = task?.parentFlowId?.trim();
      if (!task || !flowId) {
        continue;
      }
      const flow = getTaskFlowByIdForOwner({
        flowId,
        callerOwnerKey: ownerSessionKey,
      });
      if (!flow) {
        continue;
      }
      const entryRouteKey = deliveryContextKey(entry.requesterOrigin);
      const flowRouteKey = deliveryContextKey(flow.requesterOrigin);
      if (
        !isExactWorkboardCompletionTaskLink({
          entry,
          task,
          flowId,
          ownerSessionKey,
        }) ||
        flow.syncMode !== "managed" ||
        flow.controllerId !== "workboard" ||
        flow.notifyPolicy !== "silent" ||
        !entryRouteKey ||
        entryRouteKey !== flowRouteKey
      ) {
        continue;
      }
      const flowIsNonTerminal =
        flow.status === "queued" ||
        flow.status === "running" ||
        flow.status === "waiting" ||
        flow.status === "blocked";
      const activeLatestGeneration =
        typeof entry.endedAt !== "number" &&
        entry.execution?.status !== "terminal" &&
        (task.status === "queued" || task.status === "running") &&
        flowIsNonTerminal &&
        flow.cancelRequestedAt == null;
      if (activeLatestGeneration) {
        return true;
      }

      const delivery = entry.delivery;
      const intent = delivery?.verifiedWorkboardCompletion;
      const intentRouteKey = deliveryContextKey(intent?.requesterOrigin);
      const intentCanDeliver =
        delivery?.status === "pending" ||
        delivery?.status === "in_progress" ||
        delivery?.status === "suspended" ||
        delivery?.status === "delivered";
      const flowCanProjectIntent =
        flowIsNonTerminal &&
        (flow.cancelRequestedAt == null ||
          (intent !== undefined && intent.acceptedAt <= flow.cancelRequestedAt));
      if (
        intent &&
        intentCanDeliver &&
        flowCanProjectIntent &&
        delivery.obligationId === intent.obligationId &&
        intent.childSessionKey === entry.childSessionKey &&
        intent.runId === entry.runId &&
        intent.flowId === flow.flowId &&
        intent.flowOwnerSessionKey === ownerSessionKey &&
        intent.requesterSessionKey === ownerSessionKey &&
        intent.controllerId === "workboard" &&
        intentRouteKey === entryRouteKey
      ) {
        return true;
      }
    } catch {
      // Suppression is fail closed: any ambiguous registry/task/flow read keeps
      // the ordinary interruption notice eligible.
    }
  }
  return false;
}

function reconcileVerifiedWorkboardTaskProjection(entry: SubagentRunRecord): boolean {
  const intent = entry.delivery?.verifiedWorkboardCompletion;
  if (!intent || typeof entry.endedAt !== "number") {
    return false;
  }
  const taskResolution = findSubagentTaskForRun(entry);
  if (
    taskResolution.lookup !== "available" ||
    !isExactWorkboardCompletionTaskLink({
      entry,
      task: taskResolution.task,
      flowId: intent.flowId,
      ownerSessionKey: intent.flowOwnerSessionKey,
    })
  ) {
    return false;
  }
  const exactTask = taskResolution.task;
  if (!exactTask) {
    return false;
  }
  if (exactTask.status === "succeeded" && exactTask.terminalSummary === intent.completionText) {
    return true;
  }
  try {
    const endedAt = entry.endedAt ?? intent.acceptedAt;
    const updated = reconcileVerifiedWorkboardCompletion({
      taskId: exactTask.taskId,
      runId: entry.runId,
      sessionKey: entry.childSessionKey,
      flowId: intent.flowId,
      acceptedAt: intent.acceptedAt,
      endedAt,
      completionText: intent.completionText,
    });
    return Boolean(
      updated &&
      updated.runId === entry.runId &&
      updated.childSessionKey === entry.childSessionKey &&
      updated.status === "succeeded" &&
      updated.terminalSummary === intent.completionText.replace(/\s+/g, " ").trim(),
    );
  } catch (error) {
    log.warn("failed to reconcile verified Workboard task projection", {
      error: formatErrorMessage(error),
      runId: entry.runId,
      childSessionKey: entry.childSessionKey,
    });
    return false;
  }
}

function finalizeVerifiedWorkboardCompletionState(
  entry: SubagentRunRecord,
  endedAt = Date.now(),
): boolean {
  const intent = entry.delivery?.verifiedWorkboardCompletion;
  if (!intent) {
    return false;
  }
  if (
    typeof entry.endedAt === "number" &&
    entry.execution?.status === "terminal" &&
    entry.outcome?.status === "ok"
  ) {
    return true;
  }
  const snapshot = structuredClone(entry);
  const outcome = withSubagentOutcomeTiming(
    { status: "ok" },
    { startedAt: entry.startedAt, endedAt },
  );
  entry.endedAt = endedAt;
  entry.endedReason = SUBAGENT_ENDED_REASON_COMPLETE;
  entry.outcome = outcome;
  entry.execution = {
    ...entry.execution,
    status: "terminal",
    startedAt: entry.startedAt,
    endedAt,
    outcome,
  };
  entry.completion = {
    required: true,
    resultText: intent.completionText,
    capturedAt: intent.acceptedAt,
  };
  entry.pauseReason = undefined;
  entry.killReconciliation = undefined;
  entry.cleanupHandled = false;
  entry.cleanupCompletedAt = undefined;
  try {
    persistSubagentRunsOrThrow();
    return true;
  } catch (error) {
    const target = entry as unknown as Record<string, unknown>;
    for (const key of Object.keys(target)) {
      delete target[key];
    }
    Object.assign(target, snapshot);
    log.warn("failed to persist verified Workboard execution-end reconciliation", {
      error: formatErrorMessage(error),
      runId: entry.runId,
      childSessionKey: entry.childSessionKey,
    });
    return false;
  }
}

function rearmSuspendedVerifiedWorkboardDelivery(entry: SubagentRunRecord): boolean {
  const delivery = entry.delivery;
  if (!delivery?.verifiedWorkboardCompletion || delivery.status !== "suspended") {
    return false;
  }
  delivery.status = "pending";
  delivery.suspendedAt = undefined;
  delivery.suspendedReason = undefined;
  delivery.lastAttemptAt = undefined;
  delivery.attemptCount = 0;
  entry.cleanupHandled = false;
  entry.cleanupCompletedAt = undefined;
  resumedRuns.delete(entry.runId);
  return true;
}

/**
 * Atomically accepts a verified Workboard result as the exact run's terminal,
 * restart-safe completion-delivery obligation.
 */
export function requireWorkboardSubagentCompletionDelivery(
  requirement: WorkboardCompletionDeliveryRequirement,
): WorkboardCompletionDeliveryRequirementResult {
  const inputPayload = normalizeVerifiedWorkboardCompletionPayload(requirement);
  if (!inputPayload) {
    return { status: "unknown", error: "invalid verified completion obligation" };
  }
  restoreSubagentRunsOnce();
  const entry = subagentRuns.get(inputPayload.runId);
  const controllerSessionKey =
    entry?.controllerSessionKey?.trim() || entry?.requesterSessionKey.trim();
  if (
    !entry ||
    entry.childSessionKey !== inputPayload.childSessionKey ||
    entry.label?.trim() !== "plugin:workboard" ||
    entry.cleanup !== "keep" ||
    controllerSessionKey !== inputPayload.flowOwnerSessionKey ||
    findLatestSubagentRunForSession(subagentRuns.values(), inputPayload.childSessionKey) !== entry
  ) {
    return { status: "unknown", error: "verified completion run ownership is unavailable" };
  }
  const existingIntent = entry.delivery?.verifiedWorkboardCompletion;
  const activeLink = existingIntent
    ? undefined
    : resolveActiveWorkboardCompletionLink(entry, inputPayload);
  if (!existingIntent && !activeLink) {
    return { status: "unknown", error: "verified completion flow linkage is unavailable" };
  }
  const requesterSessionKey = existingIntent?.requesterSessionKey ?? activeLink?.flow.ownerKey;
  const requesterOrigin = existingIntent?.requesterOrigin
    ? normalizeVerifiedWorkboardRequesterOrigin(existingIntent.requesterOrigin)
    : normalizeVerifiedWorkboardRequesterOrigin(activeLink?.flow.requesterOrigin);
  if (!requesterSessionKey) {
    return { status: "unknown", error: "verified completion requester route is unavailable" };
  }
  const payload: WorkboardVerifiedCompletionPayload = {
    ...inputPayload,
    requesterSessionKey,
    ...(requesterOrigin ? { requesterOrigin } : {}),
  };
  const entryRequesterOrigin = normalizeVerifiedWorkboardRequesterOrigin(entry.requesterOrigin);
  if (
    requesterSessionKey !== inputPayload.flowOwnerSessionKey ||
    entry.requesterSessionKey !== requesterSessionKey ||
    JSON.stringify(entryRequesterOrigin ?? {}) !== JSON.stringify(requesterOrigin ?? {})
  ) {
    return { status: "unknown", error: "verified completion requester route is unavailable" };
  }
  const payloadHash = hashVerifiedWorkboardCompletionPayload(payload);
  if (existingIntent) {
    if (
      existingIntent.obligationId !== payload.obligationId ||
      existingIntent.payloadHash !== payloadHash
    ) {
      return { status: "unknown", error: "verified completion obligation conflicts" };
    }
    if (entry.delivery?.status === "suspended") {
      rearmSuspendedVerifiedWorkboardDelivery(entry);
      try {
        persistSubagentRunsOrThrow();
      } catch {
        return { status: "unknown", error: "verified completion retry could not be persisted" };
      }
    }
    const executionStillActive =
      typeof entry.endedAt !== "number" &&
      getAgentRunContext(entry.runId)?.sessionKey === entry.childSessionKey;
    if (executionStillActive) {
      return buildWorkboardCompletionDeliveryResult("already_armed", entry, existingIntent);
    }
    if (typeof entry.endedAt !== "number" && !finalizeVerifiedWorkboardCompletionState(entry)) {
      return { status: "unknown", error: "verified completion execution end is not durable" };
    }
    reconcileVerifiedWorkboardTaskProjection(entry);
    if (
      entry.delivery?.status === "pending" &&
      typeof entry.cleanupCompletedAt !== "number" &&
      entry.cleanupHandled !== true
    ) {
      resumedRuns.delete(entry.runId);
      startSubagentAnnounceCleanupFlow(entry.runId, entry);
    }
    return buildWorkboardCompletionDeliveryResult(
      entry.delivery?.status === "delivered" ? "delivered" : "already_armed",
      entry,
      existingIntent,
    );
  }
  if (entry.delivery?.obligationId && entry.delivery.obligationId !== payload.obligationId) {
    return { status: "unknown", error: "completion delivery is owned by another obligation" };
  }

  const acceptedAt = Date.now();
  const intent: WorkboardVerifiedCompletionIntent = {
    ...payload,
    payloadHash,
    acceptedAt,
  };
  const snapshot = structuredClone(entry);
  const activeExecutionContext = getAgentRunContext(entry.runId);
  const executionStillActive = activeExecutionContext?.sessionKey === entry.childSessionKey;
  const endedAt = entry.endedAt ?? acceptedAt;
  const outcome = withSubagentOutcomeTiming(
    { status: "ok" },
    { startedAt: entry.startedAt, endedAt },
  );
  if (!executionStillActive) {
    entry.endedAt = endedAt;
    entry.endedReason = SUBAGENT_ENDED_REASON_COMPLETE;
    entry.outcome = outcome;
    entry.execution = {
      ...entry.execution,
      status: "terminal",
      startedAt: entry.startedAt,
      endedAt,
      outcome,
    };
  }
  entry.completion = {
    required: true,
    resultText: payload.completionText,
    capturedAt: acceptedAt,
  };
  entry.expectsCompletionMessage = true;
  entry.suppressCompletionDelivery = undefined;
  entry.suppressAnnounceReason = undefined;
  entry.pauseReason = undefined;
  entry.killReconciliation = undefined;
  entry.cleanupHandled = false;
  entry.cleanupCompletedAt = undefined;
  entry.wakeOnDescendantSettle = undefined;
  if (entry.orphanRecovery) {
    entry.orphanRecovery = {
      ...entry.orphanRecovery,
      status: "declined",
      predecessorRunId: entry.runId,
      successorRunId: undefined,
      updatedAt: acceptedAt,
      settledAt: acceptedAt,
      error: "verified completion accepted",
    };
  }
  entry.delivery = {
    status: "pending",
    obligationId: payload.obligationId,
    verifiedWorkboardCompletion: intent,
    createdAt: acceptedAt,
    payload: {
      obligationId: payload.obligationId,
      requesterSessionKey: payload.requesterSessionKey,
      requesterOrigin: payload.requesterOrigin,
      requesterDisplayKey: entry.requesterDisplayKey,
      childSessionKey: entry.childSessionKey,
      childRunId: entry.runId,
      task: entry.task,
      label: entry.label,
      startedAt: entry.startedAt,
      endedAt,
      outcome,
      expectsCompletionMessage: true,
      spawnMode: entry.spawnMode,
      frozenResultText: payload.completionText,
    },
  };

  try {
    // The registry commit is the arm boundary. A successful response is never
    // returned until the exact payload is durable and the run is non-resumable.
    persistSubagentRunsOrThrow();
  } catch {
    const target = entry as unknown as Record<string, unknown>;
    for (const key of Object.keys(target)) {
      delete target[key];
    }
    Object.assign(target, snapshot);
    return { status: "unknown", error: "verified completion intent could not be persisted" };
  }

  if (!executionStillActive) {
    reconcileVerifiedWorkboardTaskProjection(entry);
    resumedRuns.delete(entry.runId);
    startSubagentAnnounceCleanupFlow(entry.runId, entry);
  }
  return buildWorkboardCompletionDeliveryResult("armed", entry, intent);
}

function resolveWorkboardTaskTerminalState(task: TaskRecord): WorkboardSubagentRunStateResult {
  switch (task.status) {
    case "succeeded":
      return { status: "terminal", outcome: "ok" };
    case "timed_out":
      return {
        status: "terminal",
        outcome: "timeout",
        error: normalizeOrphanRecoveryError(task.error),
      };
    case "cancelled":
      return {
        status: "terminal",
        outcome: "killed",
        error: normalizeOrphanRecoveryError(task.error),
      };
    case "failed":
    case "lost":
      return {
        status: "terminal",
        outcome: "error",
        error: normalizeOrphanRecoveryError(task.error),
      };
    case "queued":
    case "running":
      return { status: "active" };
  }
  return { status: "unknown" };
}

function resolveWorkboardRegistryTerminalState(
  entry: SubagentRunRecord,
): WorkboardSubagentRunStateResult {
  if (entry.endedReason === SUBAGENT_ENDED_REASON_KILLED) {
    return { status: "terminal", outcome: "killed" };
  }
  const outcome = entry.outcome ?? entry.execution?.outcome;
  if (outcome?.status === "ok") {
    return { status: "terminal", outcome: "ok" };
  }
  if (outcome?.status === "timeout") {
    return { status: "terminal", outcome: "timeout" };
  }
  if (outcome?.status === "error") {
    return {
      status: "terminal",
      outcome: "error",
      error: normalizeOrphanRecoveryError(outcome.error),
    };
  }
  return { status: "terminal" };
}

/**
 * Trusted Workboard-only existence check for an exact subagent.run id.
 *
 * `absent` is returned only when the detached-task runtime positively supports
 * exact lookup and reports no row. Lookup failures remain `unknown` so callers
 * cannot treat infrastructure unavailability as proof that a run never began.
 */
export function queryWorkboardSubagentRunState(
  params: WorkboardSubagentRunStateQuery,
): WorkboardSubagentRunStateResult {
  const childSessionKey = params.childSessionKey.trim();
  const runId = params.runId.trim();
  if (!childSessionKey || !runId) {
    return { status: "unknown" };
  }

  restoreSubagentRunsOnce();
  let snapshot: Map<string, SubagentRunRecord> | undefined;
  try {
    snapshot = subagentRegistryDeps.getSubagentRunsSnapshotForReadStrict(subagentRuns);
  } catch {
    // An exact detached-task row can still prove presence below. Absence is not
    // trustworthy when either durable source is unavailable.
  }

  const exactRegistryRun = snapshot?.get(runId);
  const trustedRegistryRun =
    exactRegistryRun?.childSessionKey === childSessionKey &&
    exactRegistryRun.label?.trim() === "plugin:workboard"
      ? exactRegistryRun
      : undefined;
  const latest = snapshot
    ? findLatestSubagentRunForSession(snapshot.values(), childSessionKey)
    : undefined;
  const trustedLatest = latest?.label?.trim() === "plugin:workboard" ? latest : undefined;
  const trustedPendingSuccessor =
    trustedLatest?.orphanRecovery?.status === "core_owned" &&
    trustedLatest.orphanRecovery.successorRunId === runId;

  if (exactRegistryRun && !trustedRegistryRun) {
    return { status: "unknown" };
  }
  if (
    trustedRegistryRun?.orphanRecovery?.status === "core_owned" &&
    trustedRegistryRun.orphanRecovery.successorRunId !== runId
  ) {
    return { status: "unknown" };
  }

  let durableTaskReadAvailable = false;
  let latestDurableSubagentTask: TaskRecord | undefined;
  let exactDurableTaskCount = 0;
  try {
    const durableTasks = listTasksForSessionKeyForStatusStrict(childSessionKey).filter(
      (task) => task.runtime === "subagent" && task.childSessionKey === childSessionKey,
    );
    durableTaskReadAvailable = true;
    latestDurableSubagentTask = durableTasks[0];
    exactDurableTaskCount = durableTasks.filter((task) => task.runId === runId).length;
  } catch {
    // Exact absence and latest-generation claims require both durable sources.
  }

  let taskLookupAvailable: boolean | undefined;
  let exactTask: TaskRecord | undefined;
  try {
    const resolution = findDetachedTaskRunStrict({
      runId,
      runtime: "subagent",
      sessionKey: childSessionKey,
      createdAtOrAfter: 0,
      allowSessionFallback: false,
    });
    taskLookupAvailable = resolution.lookup === "available";
    const candidate = resolution.task;
    if (
      candidate?.runId === runId &&
      candidate.childSessionKey === childSessionKey &&
      candidate.label?.trim() === "plugin:workboard"
    ) {
      exactTask = candidate;
    } else if (candidate) {
      // A custom runtime ignored an exact ownership field. Its result cannot
      // prove either presence or absence for Workboard.
      taskLookupAvailable = false;
    }
  } catch {
    taskLookupAvailable = false;
  }

  // An older exact row/task is not current ownership. The only trusted run id
  // different from the latest row is its explicitly preclaimed successor.
  if (latest && !trustedLatest) {
    return { status: "unknown" };
  }
  if (trustedRegistryRun?.delivery?.verifiedWorkboardCompletion && trustedLatest?.runId === runId) {
    const executionStillActive =
      typeof trustedRegistryRun.endedAt !== "number" &&
      getAgentRunContext(trustedRegistryRun.runId)?.sessionKey ===
        trustedRegistryRun.childSessionKey;
    if (executionStillActive) {
      return {
        status: "active",
        ...resolveWorkboardCompletionDeliveryView(trustedRegistryRun),
      };
    }
    if (
      typeof trustedRegistryRun.endedAt !== "number" &&
      !finalizeVerifiedWorkboardCompletionState(trustedRegistryRun)
    ) {
      return { status: "unknown" };
    }
    reconcileVerifiedWorkboardTaskProjection(trustedRegistryRun);
    if (rearmSuspendedVerifiedWorkboardDelivery(trustedRegistryRun)) {
      persistSubagentRuns();
      startSubagentAnnounceCleanupFlow(trustedRegistryRun.runId, trustedRegistryRun);
    }
    return {
      ...resolveWorkboardRegistryTerminalState(trustedRegistryRun),
      ...resolveWorkboardCompletionDeliveryView(trustedRegistryRun),
    };
  }
  if (exactTask) {
    if (
      !durableTaskReadAvailable ||
      exactDurableTaskCount > 1 ||
      (latestDurableSubagentTask &&
        (latestDurableSubagentTask.label?.trim() !== "plugin:workboard" ||
          latestDurableSubagentTask.runId !== runId)) ||
      (!latestDurableSubagentTask && !trustedRegistryRun && !trustedPendingSuccessor)
    ) {
      return { status: "unknown" };
    }
    if (trustedLatest && trustedLatest.runId !== runId && !trustedPendingSuccessor) {
      return { status: "unknown" };
    }
    return {
      ...resolveWorkboardTaskTerminalState(exactTask),
      ...resolveWorkboardCompletionDeliveryView(trustedRegistryRun),
    };
  }
  if (trustedRegistryRun) {
    if (trustedLatest && trustedLatest.runId !== runId && !trustedPendingSuccessor) {
      return { status: "unknown" };
    }
    const terminal =
      (typeof trustedRegistryRun.endedAt === "number" && trustedRegistryRun.endedAt > 0) ||
      trustedRegistryRun.execution?.status === "terminal";
    return terminal
      ? {
          ...resolveWorkboardRegistryTerminalState(trustedRegistryRun),
          ...resolveWorkboardCompletionDeliveryView(trustedRegistryRun),
        }
      : { status: "active", ...resolveWorkboardCompletionDeliveryView(trustedRegistryRun) };
  }

  const activeContext = getAgentRunContext(runId);
  if (trustedPendingSuccessor && activeContext?.sessionKey === childSessionKey) {
    return { status: "active" };
  }
  if (activeContext) {
    // A run context without trusted Workboard lineage must never be exposed to
    // the plugin, even if its caller-supplied session happens to match.
    return { status: "unknown" };
  }
  if (snapshot && taskLookupAvailable && durableTaskReadAvailable) {
    return { status: "absent" };
  }
  return { status: "unknown" };
}

/** Trusted, fail-closed recovery ownership view for the Workboard runtime bridge. */
export function querySubagentRecoveryOwnership(
  params: SubagentRecoveryOwnershipQuery,
): SubagentRecoveryOwnershipResult {
  const childSessionKey = params.childSessionKey.trim();
  const predecessorRunId = params.predecessorRunId.trim();
  if (!childSessionKey || !predecessorRunId) {
    return { status: "unknown" };
  }
  restoreSubagentRunsOnce();
  let runsSnapshot: Map<string, SubagentRunRecord>;
  try {
    runsSnapshot = subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns);
  } catch {
    return { status: "unknown" };
  }
  const latest = findLatestSubagentRunForSession(runsSnapshot.values(), childSessionKey);
  if (!latest || latest.label?.trim() !== "plugin:workboard") {
    return { status: "unknown" };
  }
  const recovery = latest.orphanRecovery;
  if (
    !recovery ||
    (recovery.predecessorRunId !== predecessorRunId && recovery.rootRunId !== predecessorRunId)
  ) {
    return { status: "unknown" };
  }
  if (
    recovery.status === "core_owned" &&
    recovery.predecessorRunId === latest.runId &&
    recovery.successorRunId
  ) {
    return { status: "core_owned", successorRunId: recovery.successorRunId };
  }
  if (
    recovery.status === "successor" &&
    recovery.successorRunId === latest.runId &&
    latest.runId !== predecessorRunId
  ) {
    return { status: "successor", successorRunId: latest.runId };
  }
  if (
    (recovery.status === "exhausted" || recovery.status === "declined") &&
    recovery.predecessorRunId === latest.runId
  ) {
    return {
      status: "exhausted",
      error:
        recovery.status === "declined"
          ? "automatic subagent recovery declined"
          : "automatic subagent recovery exhausted",
    };
  }
  return { status: "unknown" };
}

export function isSubagentSessionRunActive(childSessionKey: string): boolean {
  return isSubagentSessionRunActiveFromRuns(subagentRuns, childSessionKey);
}

export function shouldIgnorePostCompletionAnnounceForSession(childSessionKey: string): boolean {
  return shouldIgnorePostCompletionAnnounceForSessionFromRuns(
    subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns),
    childSessionKey,
  );
}

export function markSubagentRunTerminated(params: {
  runId?: string;
  childSessionKey?: string;
  reason?: string;
  suppressTaskDelivery?: boolean;
}): number {
  return subagentRunManager.markSubagentRunTerminated(params);
}

export function listSubagentRunsForRequester(
  requesterSessionKey: string,
  options?: { requesterRunId?: string },
): SubagentRunRecord[] {
  return listRunsForRequesterFromRuns(subagentRuns, requesterSessionKey, options);
}

export function leasePendingAgentSteeringItems(params: {
  requesterSessionKey: string;
  leaseId: string;
  now?: number;
}) {
  restoreSubagentRunsOnce();
  const leased = leasePendingAgentSteeringItemsFromSubagentRuns({
    runs: subagentRuns,
    requesterSessionKey: params.requesterSessionKey,
    leaseId: params.leaseId,
    now: params.now,
  });
  if (leased) {
    persistSubagentRuns();
  }
  return leased;
}

export function ackPendingAgentSteeringItems(params: {
  runIds: readonly string[];
  leaseId: string;
  now?: number;
}): number {
  const updated = ackLeasedAgentSteeringItemsFromSubagentRuns({
    runs: subagentRuns,
    runIds: params.runIds,
    leaseId: params.leaseId,
    now: params.now,
  });
  if (updated > 0) {
    persistSubagentRuns();
    for (const runId of params.runIds) {
      const entry = subagentRuns.get(runId);
      if (!entry || typeof entry.cleanupCompletedAt === "number") {
        continue;
      }
      entry.cleanupHandled = false;
      startSubagentAnnounceCleanupFlow(runId, entry);
    }
  }
  return updated;
}

export function releasePendingAgentSteeringItems(params: {
  runIds: readonly string[];
  leaseId: string;
  error?: string;
}): number {
  const updated = releaseLeasedAgentSteeringItemsFromSubagentRuns({
    runs: subagentRuns,
    runIds: params.runIds,
    leaseId: params.leaseId,
    error: params.error,
  });
  if (updated > 0) {
    persistSubagentRuns();
  }
  return updated;
}

export { prependAgentSteeringPrompt };

export function listSubagentRunsForController(controllerSessionKey: string): SubagentRunRecord[] {
  return listRunsForControllerFromRuns(
    subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns),
    controllerSessionKey,
  );
}

export function countActiveRunsForSession(requesterSessionKey: string): number {
  return countActiveRunsForSessionFromRuns(
    subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns),
    requesterSessionKey,
  );
}

export function countActiveDescendantRuns(rootSessionKey: string): number {
  return countActiveDescendantRunsFromRuns(
    subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
  );
}

export function countPendingDescendantRuns(rootSessionKey: string): number {
  return countPendingDescendantRunsFromRuns(
    subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
  );
}

export function countPendingDescendantRunsExcludingRun(
  rootSessionKey: string,
  excludeRunId: string,
): number {
  return countPendingDescendantRunsExcludingRunFromRuns(
    subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
    excludeRunId,
  );
}

export function listDescendantRunsForRequester(rootSessionKey: string): SubagentRunRecord[] {
  return listDescendantRunsForRequesterFromRuns(
    subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
  );
}

export function getSubagentRunByChildSessionKey(childSessionKey: string): SubagentRunRecord | null {
  return getSubagentRunByChildSessionKeyFromRuns(
    subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns),
    childSessionKey,
  );
}

export function getLatestSubagentRunByChildSessionKey(
  childSessionKey: string,
): SubagentRunRecord | null {
  const key = childSessionKey.trim();
  if (!key) {
    return null;
  }

  let latest: SubagentRunRecord | null = null;
  for (const entry of subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns).values()) {
    if (entry.childSessionKey !== key) {
      continue;
    }
    if (!latest || compareSubagentRunGeneration(entry, latest) > 0) {
      latest = entry;
    }
  }

  return latest;
}

export function initSubagentRegistry() {
  restoreSubagentRunsOnce();
}

// Importing this module also registers the subagent maintenance preserve-key
// provider as a side effect (see subagent-registry-maintenance.ts).
export { listSessionMaintenanceProtectedSubagentSessionKeys } from "./subagent-registry-maintenance.js";
export { testing as __testing };
