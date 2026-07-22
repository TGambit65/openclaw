// Coordinates verified Workboard completion with core delivery and managed TaskFlow state.
import path from "node:path";
import type {
  WorkboardCompletionCommitProjection,
  WorkboardCompleteInput,
  WorkboardMutationScope,
  WorkboardPreparedCompletion,
} from "./store.js";
import { WorkboardStore } from "./store.js";
import type {
  WorkboardCard,
  WorkboardCompletionArtifactIdentity,
  WorkboardCompletionDeliveryStatus,
  WorkboardCompletionProofIdentity,
  WorkboardManagedFlowView,
  WorkboardRequesterOrigin,
} from "./types.js";

export type WorkboardVerifiedCompletionIntent = {
  kind: "verified_workboard_completion";
  obligationId: string;
  cardId: string;
  childSessionKey: string;
  runId: string;
  expectedRunId: string;
  expectedRevision: string;
  claimOwnerId: string;
  requesterSessionKey: string;
  requesterOrigin?: WorkboardRequesterOrigin;
  summary: string;
  completionText: string;
  proof: WorkboardCompletionProofIdentity;
  artifacts: WorkboardCompletionArtifactIdentity[];
  createdCardIds?: string[];
  payloadHash: string;
  acceptedAt: number;
  flowId: string;
  flowOwnerSessionKey: string;
  flowRevision: number;
  controllerId: "workboard";
};

export type WorkboardCompletionRunState = {
  status: "unknown" | "absent" | "active" | "terminal";
  outcome?: "ok" | "error" | "timeout" | "killed";
  error?: string;
  deliveryStatus?: "not_required" | WorkboardCompletionDeliveryStatus;
  deliveredAt?: number;
  deliveryError?: string;
  discardReason?: string;
  verifiedCompletionIntent?: WorkboardVerifiedCompletionIntent;
};

export type WorkboardCompletionDeliveryRuntime = {
  requireCompletionDelivery(params: {
    sessionKey: string;
    runId: string;
    idempotencyKey: string;
    cardId: string;
    expectedRevision: string;
    expectedRunId: string;
    claimOwnerId: string;
    summary: string;
    completionText: string;
    proof: WorkboardCompletionProofIdentity;
    artifacts: WorkboardCompletionArtifactIdentity[];
    createdCardIds: string[];
    flowId: string;
    flowOwnerSessionKey: string;
    flowRevision: number;
    controllerId: "workboard";
  }): Promise<
    | {
        status: "armed" | "already_armed" | "delivered";
        deliveryStatus: WorkboardCompletionRunState["deliveryStatus"];
        deliveredAt?: number;
        verifiedCompletionIntent: WorkboardVerifiedCompletionIntent;
      }
    | { status: "unknown"; error?: string }
  >;
  getRunState(params: { sessionKey: string; runId: string }): Promise<WorkboardCompletionRunState>;
};

type ManagedFlowRecord = {
  flowId: string;
  syncMode: "task_mirrored" | "managed";
  ownerKey: string;
  controllerId?: string;
  revision: number;
  status: WorkboardManagedFlowView["status"];
  currentStep?: string;
  stateJson?: unknown;
  waitJson?: unknown;
  cancelRequestedAt?: number;
};

type ManagedFlowJsonValue =
  | null
  | boolean
  | number
  | string
  | ManagedFlowJsonValue[]
  | { [key: string]: ManagedFlowJsonValue };

type ManagedFlowMutationResult =
  | { applied: true; flow: ManagedFlowRecord }
  | {
      applied: false;
      code:
        | "not_found"
        | "not_managed"
        | "revision_conflict"
        | "persist_failed"
        | "completion_cancel_conflict";
      current?: unknown;
    };

type BoundManagedFlowRuntime = {
  get(flowId: string): ManagedFlowRecord | undefined;
  getTaskSummary(flowId: string): unknown;
  setWaiting(params: {
    flowId: string;
    expectedRevision: number;
    currentStep?: string | null;
    stateJson?: ManagedFlowJsonValue | null;
    waitJson?: ManagedFlowJsonValue | null;
    blockedSummary?: string | null;
    completionAcceptedAt?: number;
  }): ManagedFlowMutationResult;
  finish(params: {
    flowId: string;
    expectedRevision: number;
    stateJson?: ManagedFlowJsonValue | null;
    endedAt?: number;
    completionAcceptedAt?: number;
  }): ManagedFlowMutationResult;
  fail(params: {
    flowId: string;
    expectedRevision: number;
    stateJson?: ManagedFlowJsonValue | null;
    blockedSummary?: string | null;
    endedAt?: number;
    completionAcceptedAt?: number;
  }): ManagedFlowMutationResult;
};

export type WorkboardCompletionTaskFlowRuntime = {
  bindSession(params: { sessionKey: string }): BoundManagedFlowRuntime;
};

export type WorkboardCompletionCoordinator = (
  id: string,
  input: WorkboardCompleteInput,
  scope: WorkboardMutationScope | null | undefined,
) => Promise<WorkboardCard>;

export type WorkboardCompletionReconciliationOptions = {
  store: WorkboardStore;
  subagent: WorkboardCompletionDeliveryRuntime;
  taskFlow?: WorkboardCompletionTaskFlowRuntime;
  onDelivered?: (card: WorkboardCard, intent: WorkboardVerifiedCompletionIntent) => Promise<void>;
  logger?: {
    warn(message: string, metadata?: Record<string, unknown>): void;
  };
};

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function containsTokenKey(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(containsTokenKey);
  }
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) => /token/iu.test(key) || containsTokenKey(child),
  );
}

function assertVerifiedIntent(intent: WorkboardVerifiedCompletionIntent): void {
  if (
    intent.kind !== "verified_workboard_completion" ||
    !intent.obligationId ||
    !intent.cardId ||
    !intent.childSessionKey ||
    !intent.runId ||
    intent.expectedRunId !== intent.runId ||
    !intent.expectedRevision ||
    !intent.claimOwnerId ||
    !intent.requesterSessionKey ||
    !intent.summary.trim() ||
    !intent.completionText.trim() ||
    intent.proof?.status !== "passed" ||
    !intent.payloadHash ||
    !intent.flowId ||
    !intent.flowOwnerSessionKey ||
    intent.controllerId !== "workboard" ||
    !Number.isSafeInteger(intent.flowRevision) ||
    !Number.isFinite(intent.acceptedAt) ||
    containsTokenKey(intent)
  ) {
    throw new Error("invalid or unsafe verified Workboard completion intent.");
  }
  if (
    !intent.artifacts.length ||
    intent.artifacts.some(
      (artifact) =>
        !path.isAbsolute(artifact.path) ||
        typeof artifact.byteSize !== "number" ||
        !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
        typeof artifact.verifiedAt !== "number",
    )
  ) {
    throw new Error("verified Workboard completion intent has invalid artifact identity.");
  }
}

function preparedMatchesIntent(
  prepared: WorkboardPreparedCompletion,
  intent: WorkboardVerifiedCompletionIntent,
): boolean {
  // Evidence timestamps and generated ids describe when this *attempt* read the
  // evidence. They necessarily change when a caller retries after the native
  // arm response was lost. The immutable core intent remains authoritative;
  // compare the proof and artifact content identity without those volatile
  // observation fields so an exact retry can recover the accepted intent.
  const proofIdentity = ({
    id: _id,
    createdAt: _createdAt,
    ...identity
  }: WorkboardCompletionProofIdentity) => identity;
  const artifactIdentity = ({
    id: _id,
    createdAt: _createdAt,
    verifiedAt: _verifiedAt,
    ...identity
  }: WorkboardCompletionArtifactIdentity) => identity;
  return (
    prepared.cardId === intent.cardId &&
    prepared.obligationId === intent.obligationId &&
    prepared.sessionKey === intent.childSessionKey &&
    prepared.runId === intent.runId &&
    prepared.expectedRunId === intent.expectedRunId &&
    prepared.claimOwnerId === intent.claimOwnerId &&
    prepared.summary === intent.summary &&
    prepared.completionText === intent.completionText &&
    JSON.stringify(proofIdentity(prepared.proof)) === JSON.stringify(proofIdentity(intent.proof)) &&
    JSON.stringify(prepared.artifacts.map(artifactIdentity)) ===
      JSON.stringify(intent.artifacts.map(artifactIdentity)) &&
    JSON.stringify(prepared.createdCardIds) === JSON.stringify(intent.createdCardIds ?? []) &&
    prepared.flowId === intent.flowId &&
    prepared.flowOwnerSessionKey === intent.flowOwnerSessionKey &&
    prepared.controllerId === intent.controllerId
  );
}

function armParams(prepared: WorkboardPreparedCompletion) {
  return {
    sessionKey: prepared.sessionKey,
    runId: prepared.runId,
    idempotencyKey: prepared.obligationId,
    cardId: prepared.cardId,
    expectedRevision: prepared.expectedRevision,
    expectedRunId: prepared.expectedRunId,
    claimOwnerId: prepared.claimOwnerId,
    summary: prepared.summary,
    completionText: prepared.completionText,
    proof: prepared.proof,
    artifacts: prepared.artifacts,
    createdCardIds: prepared.createdCardIds,
    flowId: prepared.flowId,
    flowOwnerSessionKey: prepared.flowOwnerSessionKey,
    flowRevision: prepared.flowRevision,
    controllerId: prepared.controllerId,
  };
}

function deliveryProjection(params: {
  intent: WorkboardVerifiedCompletionIntent;
  state: WorkboardCompletionRunState;
  flowRevision: number;
}): WorkboardCompletionCommitProjection {
  const status =
    params.state.deliveryStatus && params.state.deliveryStatus !== "not_required"
      ? params.state.deliveryStatus
      : "pending";
  const {
    childSessionKey,
    requesterSessionKey: _requesterSessionKey,
    requesterOrigin: _requesterOrigin,
    ...intent
  } = params.intent;
  return {
    ...intent,
    sessionKey: childSessionKey,
    status,
    flowRevision: params.flowRevision,
    ...(typeof params.state.deliveredAt === "number"
      ? { deliveredAt: params.state.deliveredAt }
      : {}),
    ...(params.state.deliveryError ? { lastError: params.state.deliveryError } : {}),
    ...(params.state.discardReason ? { discardReason: params.state.discardReason } : {}),
  };
}

function completionFlowState(
  intent: WorkboardVerifiedCompletionIntent,
  deliveryStatus: WorkboardCompletionDeliveryStatus,
) {
  return {
    kind: "workboard_verified_completion",
    controllerId: "workboard",
    cardId: intent.cardId,
    obligationId: intent.obligationId,
    runId: intent.runId,
    payloadHash: intent.payloadHash,
    deliveryStatus,
  };
}

function completionWait(intent: WorkboardVerifiedCompletionIntent) {
  return {
    kind: "workboard_completion_delivery",
    reason: "awaiting_native_completion_delivery",
    cardId: intent.cardId,
    obligationId: intent.obligationId,
    wake: {
      kind: "subagent_completion_delivery",
      sessionKey: intent.childSessionKey,
      runId: intent.runId,
    },
  };
}

function flowAlreadyReflects(
  flow: ManagedFlowRecord,
  intent: WorkboardVerifiedCompletionIntent,
  deliveryStatus: WorkboardCompletionDeliveryStatus,
): boolean {
  const state = objectRecord(flow.stateJson);
  if (state.obligationId !== intent.obligationId || state.cardId !== intent.cardId) {
    return false;
  }
  if (deliveryStatus === "delivered") {
    return flow.status === "succeeded";
  }
  if (deliveryStatus === "failed" || deliveryStatus === "discarded") {
    return flow.status === "failed";
  }
  const wait = objectRecord(flow.waitJson);
  return flow.status === "waiting" && wait.obligationId === intent.obligationId;
}

async function syncManagedFlow(params: {
  taskFlow?: WorkboardCompletionTaskFlowRuntime;
  intent: WorkboardVerifiedCompletionIntent;
  workflowIdempotencyKey: string;
  deliveryStatus: WorkboardCompletionDeliveryStatus;
  terminal: boolean;
  deliveredAt?: number;
  error?: string;
}): Promise<ManagedFlowRecord> {
  if (!params.taskFlow) {
    throw new Error("verified completion delivery requires the managed TaskFlow runtime.");
  }
  const bound = params.taskFlow.bindSession({ sessionKey: params.intent.flowOwnerSessionKey });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const flow = bound.get(params.intent.flowId);
    if (
      !flow ||
      flow.syncMode !== "managed" ||
      flow.controllerId !== "workboard" ||
      flow.ownerKey !== params.intent.flowOwnerSessionKey
    ) {
      throw new Error(
        "verified completion references an unavailable or ambiguous managed TaskFlow.",
      );
    }
    const flowIdentity = objectRecord(flow.stateJson);
    if (
      flowIdentity.schema !== "openclaw.workboard.managed-flow.v1" ||
      flowIdentity.controllerId !== "workboard" ||
      flowIdentity.cardId !== params.intent.cardId ||
      flowIdentity.workflowIdempotencyKey !== params.workflowIdempotencyKey
    ) {
      throw new Error("verified completion references a stale or corrupt managed TaskFlow state.");
    }
    if (flowAlreadyReflects(flow, params.intent, params.deliveryStatus)) {
      return flow;
    }
    const completionPrecedesCancellation =
      flow.cancelRequestedAt === undefined || params.intent.acceptedAt <= flow.cancelRequestedAt;
    if (flow.cancelRequestedAt !== undefined && !completionPrecedesCancellation) {
      throw new Error("managed TaskFlow cancellation predates verified completion acceptance.");
    }
    // Persisting the exact core-owned verified intent is the completion commit
    // point. A later flow cancel may race physical worker shutdown, but it must
    // not strand that already-armed delivery. Exact flow/card identity and
    // acceptance ordering were validated above, so only cancellation is
    // recoverable here.
    if (
      ["succeeded", "failed", "lost"].includes(flow.status) ||
      (flow.status === "cancelled" && !completionPrecedesCancellation)
    ) {
      throw new Error("managed TaskFlow reached a conflicting terminal state.");
    }
    const stateJson = {
      ...objectRecord(flow.stateJson),
      ...completionFlowState(params.intent, params.deliveryStatus),
    };
    let result: ManagedFlowMutationResult;
    if (params.deliveryStatus === "delivered") {
      if (!params.terminal) {
        throw new Error("native completion delivery cannot finish TaskFlow before run terminal.");
      }
      result = bound.finish({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        stateJson,
        endedAt: params.deliveredAt,
        completionAcceptedAt: params.intent.acceptedAt,
      });
    } else if (params.deliveryStatus === "failed" || params.deliveryStatus === "discarded") {
      if (!params.terminal) {
        throw new Error("non-terminal run cannot fail managed completion delivery.");
      }
      result = bound.fail({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        stateJson,
        blockedSummary: params.error ?? `Completion delivery ${params.deliveryStatus}.`,
        completionAcceptedAt: params.intent.acceptedAt,
      });
    } else {
      result = bound.setWaiting({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        currentStep: "completion_delivery",
        stateJson,
        waitJson: completionWait(params.intent),
        blockedSummary: null,
        completionAcceptedAt: params.intent.acceptedAt,
      });
    }
    if (result.applied) {
      return result.flow;
    }
    if (result.code !== "revision_conflict") {
      throw new Error(`managed TaskFlow completion update failed: ${result.code}`);
    }
  }
  throw new Error("managed TaskFlow changed concurrently during completion delivery.");
}

function stateDeliveryStatus(
  state: WorkboardCompletionRunState,
): WorkboardCompletionDeliveryStatus {
  const status = state.deliveryStatus;
  return status && status !== "not_required" ? status : "pending";
}

async function projectIntent(params: {
  store: WorkboardStore;
  taskFlow?: WorkboardCompletionTaskFlowRuntime;
  intent: WorkboardVerifiedCompletionIntent;
  state: WorkboardCompletionRunState;
}): Promise<WorkboardCard> {
  assertVerifiedIntent(params.intent);
  const card = await params.store.get(params.intent.cardId);
  if (!card) {
    throw new Error(`card not found: ${params.intent.cardId}`);
  }
  const workflowIdempotencyKey =
    card.metadata?.automation?.idempotencyKey ?? `workboard:${card.id}:workflow`;
  const deliveryStatus = stateDeliveryStatus(params.state);
  const flow = await syncManagedFlow({
    taskFlow: params.taskFlow,
    intent: params.intent,
    workflowIdempotencyKey,
    deliveryStatus,
    terminal: params.state.status === "terminal",
    deliveredAt: params.state.deliveredAt,
    error: params.state.deliveryError ?? params.state.discardReason,
  });
  return await params.store.commitVerifiedCompletionIntent(
    deliveryProjection({ intent: params.intent, state: params.state, flowRevision: flow.revision }),
  );
}

export async function completeWorkboardCardWithDelivery(params: {
  store: WorkboardStore;
  subagent: WorkboardCompletionDeliveryRuntime;
  taskFlow?: WorkboardCompletionTaskFlowRuntime;
  id: string;
  input?: WorkboardCompleteInput;
  scope?: WorkboardMutationScope | null;
}): Promise<WorkboardCard> {
  const input = params.input ?? {};
  const prepared = await params.store.prepareVerifiedCompletionIntent(
    params.id,
    input,
    params.scope ?? input,
  );
  if (!prepared) {
    return await params.store.complete(params.id, input, params.scope ?? input);
  }
  const before = await params.subagent.getRunState({
    sessionKey: prepared.sessionKey,
    runId: prepared.runId,
  });
  if (before.verifiedCompletionIntent) {
    assertVerifiedIntent(before.verifiedCompletionIntent);
    if (!preparedMatchesIntent(prepared, before.verifiedCompletionIntent)) {
      throw new Error("verified completion retry conflicts with the core-owned obligation.");
    }
    return await projectIntent({
      store: params.store,
      taskFlow: params.taskFlow,
      intent: before.verifiedCompletionIntent,
      state: before,
    });
  }

  const armed = await params.subagent.requireCompletionDelivery(armParams(prepared));
  let state = await params.subagent.getRunState({
    sessionKey: prepared.sessionKey,
    runId: prepared.runId,
  });
  const armedIntent = armed.status === "unknown" ? undefined : armed.verifiedCompletionIntent;
  const intent = state.verifiedCompletionIntent ?? armedIntent;
  if (!intent) {
    throw new Error(
      `core did not persist the verified Workboard completion intent${
        armed.status === "unknown" && armed.error ? `: ${armed.error}` : "."
      }`,
    );
  }
  if (!state.verifiedCompletionIntent) {
    state = {
      ...state,
      deliveryStatus: armed.status === "unknown" ? state.deliveryStatus : armed.deliveryStatus,
      deliveredAt: armed.status === "unknown" ? state.deliveredAt : armed.deliveredAt,
      verifiedCompletionIntent: intent,
    };
  }
  if (!preparedMatchesIntent(prepared, intent)) {
    throw new Error("core accepted a verified completion intent that does not match Workboard.");
  }
  return await projectIntent({
    store: params.store,
    taskFlow: params.taskFlow,
    intent,
    state,
  });
}

function cardRunTarget(card: WorkboardCard): { sessionKey: string; runId: string } | undefined {
  const delivery = card.metadata?.automation?.completionDelivery;
  const sessionKey =
    delivery?.sessionKey ??
    card.sessionKey ??
    card.execution?.sessionKey ??
    card.metadata?.automation?.startSessionKey;
  const runId =
    delivery?.runId ??
    card.runId ??
    card.execution?.runId ??
    card.metadata?.automation?.startIdempotencyKey;
  return sessionKey && runId ? { sessionKey, runId } : undefined;
}

export async function reconcileWorkboardCompletionDeliveries(
  options: WorkboardCompletionReconciliationOptions,
): Promise<{ needsContinuation: boolean }> {
  let needsContinuation = false;
  for (const card of await options.store.list()) {
    const delivery = card.metadata?.automation?.completionDelivery;
    const shouldInspect =
      Boolean(delivery) ||
      Boolean(
        card.metadata?.automation?.idempotencyKey &&
        (card.execution?.mode === "autonomous" || card.metadata.automation.startIdempotencyKey),
      );
    if (!shouldInspect) {
      continue;
    }
    if (delivery?.status === "delivered" && delivery.cleanupCompletedAt) {
      continue;
    }
    const target = cardRunTarget(card);
    if (!target) {
      continue;
    }
    try {
      let state = await options.subagent.getRunState(target);
      let intent = state.verifiedCompletionIntent;
      if (intent && state.deliveryStatus === "suspended") {
        // Suspension is a bounded-delivery pause, not a terminal workflow
        // failure. Re-arm the same immutable obligation and keep the managed
        // flow waiting for requester acknowledgement.
        const rearmed = await options.subagent.requireCompletionDelivery({
          sessionKey: intent.childSessionKey,
          runId: intent.runId,
          idempotencyKey: intent.obligationId,
          cardId: intent.cardId,
          expectedRevision: intent.expectedRevision,
          expectedRunId: intent.expectedRunId,
          claimOwnerId: intent.claimOwnerId,
          summary: intent.summary,
          completionText: intent.completionText,
          proof: intent.proof,
          artifacts: intent.artifacts,
          createdCardIds: intent.createdCardIds ?? [],
          flowId: intent.flowId,
          flowOwnerSessionKey: intent.flowOwnerSessionKey,
          flowRevision: intent.flowRevision,
          controllerId: intent.controllerId,
        });
        state = await options.subagent.getRunState(target);
        intent =
          state.verifiedCompletionIntent ??
          (rearmed.status === "unknown" ? undefined : rearmed.verifiedCompletionIntent) ??
          intent;
      }
      if (!intent && delivery) {
        throw new Error(
          "core has not restored the pending verified completion intent; retrying fail closed.",
        );
      }
      if (!intent) {
        continue;
      }
      if (intent.cardId !== card.id) {
        continue;
      }
      if (!state.verifiedCompletionIntent) {
        state = { ...state, verifiedCompletionIntent: intent };
      }
      const projected = await projectIntent({
        store: options.store,
        taskFlow: options.taskFlow,
        intent,
        state,
      });
      const projectedDelivery = projected.metadata?.automation?.completionDelivery;
      if (
        projected.status === "done" &&
        projectedDelivery?.status === "delivered" &&
        !projectedDelivery.cleanupCompletedAt &&
        options.onDelivered
      ) {
        await options.onDelivered(projected, intent);
        await options.store.markCompletionDeliveryCleanupCompleted({
          cardId: projected.id,
          obligationId: intent.obligationId,
        });
      }
      if (
        projectedDelivery?.status === "pending" ||
        projectedDelivery?.status === "in_progress" ||
        projectedDelivery?.status === "suspended"
      ) {
        needsContinuation = true;
      }
    } catch (error) {
      needsContinuation = true;
      options.logger?.warn("workboard completion delivery reconciliation failed", {
        cardId: card.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { needsContinuation };
}

export function readWorkboardManagedFlow(
  card: WorkboardCard,
  taskFlow: WorkboardCompletionTaskFlowRuntime,
): WorkboardManagedFlowView | undefined {
  const automation = card.metadata?.automation;
  if (!automation?.flowId || !automation.flowOwnerSessionKey) {
    return undefined;
  }
  const bound = taskFlow.bindSession({ sessionKey: automation.flowOwnerSessionKey });
  const flow = bound.get(automation.flowId);
  if (!flow || flow.syncMode !== "managed" || flow.controllerId !== "workboard") {
    return undefined;
  }
  return {
    flowId: flow.flowId,
    revision: flow.revision,
    status: flow.status,
    ...(flow.currentStep ? { currentStep: flow.currentStep } : {}),
    ...(flow.waitJson !== undefined ? { wait: flow.waitJson } : {}),
    ...(bound.getTaskSummary(flow.flowId) !== undefined
      ? { taskSummary: bound.getTaskSummary(flow.flowId) }
      : {}),
  };
}
