// Workboard's managed-flow adapter keeps TaskFlow authoritative while the card
// stores only an owner-scoped projection used to resume after process loss.
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  isAcpSessionKey,
  isCronSessionKey,
  isSubagentSessionKey,
  parseAgentSessionKey,
} from "openclaw/plugin-sdk/routing";
import type { WorkboardStore } from "./store.js";
import type { WorkboardCard, WorkboardRequesterOrigin } from "./types.js";

const WORKBOARD_FLOW_SCHEMA = "openclaw.workboard.managed-flow.v1";
const WORKBOARD_CONTROLLER_ID = "workboard";
const MAX_FLOW_REVISION_RETRIES = 5;

type ManagedFlowRuntime = ReturnType<PluginRuntime["tasks"]["managedFlows"]["bindSession"]>;
type ManagedFlowRecord = NonNullable<ReturnType<ManagedFlowRuntime["get"]>>;

export type WorkboardManagedFlowsRuntime = Pick<
  PluginRuntime["tasks"]["managedFlows"],
  "bindSession"
>;

export type WorkboardManagedFlowContext = {
  flow: ManagedFlowRecord;
  runtime: ManagedFlowRuntime;
  workerSessionKey: string;
  ownerSessionKey: string;
};

type WorkboardFlowState = {
  schema: typeof WORKBOARD_FLOW_SCHEMA;
  controllerId: typeof WORKBOARD_CONTROLLER_ID;
  cardId: string;
  workflowIdempotencyKey: string;
  phase: "starting" | "waiting_worker" | "waiting_delivery" | "finished" | "failed";
  runId?: string;
};

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function workflowIdempotencyKey(card: WorkboardCard): string {
  return card.metadata?.automation?.idempotencyKey ?? `workboard:${card.id}:workflow`;
}

function flowState(
  card: WorkboardCard,
  phase: WorkboardFlowState["phase"],
  runId?: string,
): WorkboardFlowState {
  return {
    schema: WORKBOARD_FLOW_SCHEMA,
    controllerId: WORKBOARD_CONTROLLER_ID,
    cardId: card.id,
    workflowIdempotencyKey: workflowIdempotencyKey(card),
    phase,
    ...(runId ? { runId } : {}),
  };
}

function isExactCardFlow(flow: ManagedFlowRecord, card: WorkboardCard): boolean {
  const state = readRecord(flow.stateJson);
  return (
    flow.syncMode === "managed" &&
    flow.controllerId === WORKBOARD_CONTROLLER_ID &&
    state?.schema === WORKBOARD_FLOW_SCHEMA &&
    state.controllerId === WORKBOARD_CONTROLLER_ID &&
    state.cardId === card.id &&
    state.workflowIdempotencyKey === workflowIdempotencyKey(card)
  );
}

function assertExactCardFlow(flow: ManagedFlowRecord, card: WorkboardCard): void {
  if (!isExactCardFlow(flow, card)) {
    throw new Error(`managed TaskFlow ${flow.flowId} does not belong to Workboard card ${card.id}`);
  }
}

function assertInitiatingOwner(params: {
  ownerSessionKey: string;
  workerSessionKey: string;
}): void {
  const owner = parseAgentSessionKey(params.ownerSessionKey);
  const worker = parseAgentSessionKey(params.workerSessionKey);
  if (params.ownerSessionKey === "global") {
    if (!worker || !isSubagentSessionKey(params.workerSessionKey)) {
      throw new Error("global Workboard TaskFlow owner requires a canonical subagent worker");
    }
    return;
  }
  if (
    !owner ||
    isSubagentSessionKey(params.ownerSessionKey) ||
    isAcpSessionKey(params.ownerSessionKey) ||
    isCronSessionKey(params.ownerSessionKey) ||
    owner.rest.includes(":heartbeat")
  ) {
    throw new Error("managed Workboard TaskFlow requires an initiating non-subagent session");
  }
  if (!worker || owner.agentId !== worker.agentId) {
    throw new Error("managed Workboard TaskFlow owner and worker must belong to the same agent");
  }
}

function requesterOriginsEqual(
  left: WorkboardRequesterOrigin | undefined,
  right: WorkboardRequesterOrigin | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return (
    left.channel === right.channel &&
    left.to === right.to &&
    left.accountId === right.accountId &&
    left.threadId === right.threadId
  );
}

async function projectFlow(params: {
  store: WorkboardStore;
  cardId: string;
  flow: ManagedFlowRecord;
  ownerSessionKey: string;
}): Promise<WorkboardCard> {
  const latest = await params.store.get(params.cardId);
  if (!latest) {
    throw new Error(`card not found: ${params.cardId}`);
  }
  return await params.store.projectManagedFlow(params.cardId, {
    flowId: params.flow.flowId,
    flowOwnerSessionKey: params.ownerSessionKey,
    flowRevision: params.flow.revision,
    controllerId: WORKBOARD_CONTROLLER_ID,
    ...(latest.metadata?.automation?.requesterSessionKey
      ? { expectedRequesterSessionKey: latest.metadata.automation.requesterSessionKey }
      : {}),
    clearRequesterRoute: true,
  });
}

export async function ensureWorkboardManagedFlow(params: {
  store: WorkboardStore;
  card: WorkboardCard;
  workerSessionKey: string;
  requesterSessionKey?: string;
  requesterOrigin?: WorkboardRequesterOrigin;
  managedFlows: WorkboardManagedFlowsRuntime;
  now?: number;
}): Promise<{ card: WorkboardCard; context: WorkboardManagedFlowContext }> {
  const projection = params.card.metadata?.automation;
  const workerSessionKey = params.workerSessionKey.trim();
  const requestedOwnerSessionKey =
    params.requesterSessionKey?.trim() || projection?.requesterSessionKey?.trim();
  const ownerSessionKey = projection?.flowOwnerSessionKey?.trim() || requestedOwnerSessionKey;
  if (!workerSessionKey || !ownerSessionKey) {
    throw new Error("managed Workboard TaskFlow requires an exact initiating requester session");
  }
  if (
    projection?.flowOwnerSessionKey &&
    requestedOwnerSessionKey &&
    projection.flowOwnerSessionKey !== requestedOwnerSessionKey
  ) {
    throw new Error(`Workboard card ${params.card.id} has a mismatched managed-flow owner`);
  }
  assertInitiatingOwner({ ownerSessionKey, workerSessionKey });
  const requesterOrigin = params.requesterOrigin ?? projection?.requesterOrigin;
  const runtime = params.managedFlows.bindSession({
    sessionKey: ownerSessionKey,
    ...(requesterOrigin ? { requesterOrigin } : {}),
  });
  const matching = runtime.list().filter((flow) => isExactCardFlow(flow, params.card));
  if (matching.length > 1) {
    throw new Error(`multiple managed TaskFlows match Workboard card ${params.card.id}`);
  }

  let flow: ManagedFlowRecord;
  if (projection?.flowId) {
    if (
      projection.flowOwnerSessionKey !== ownerSessionKey ||
      projection.controllerId !== "workboard"
    ) {
      throw new Error(`Workboard card ${params.card.id} has a mismatched managed-flow owner`);
    }
    const projected = runtime.get(projection.flowId);
    if (!projected) {
      throw new Error(`projected managed TaskFlow ${projection.flowId} was not found`);
    }
    assertExactCardFlow(projected, params.card);
    if (
      projected.ownerKey !== ownerSessionKey ||
      (requesterOrigin && !requesterOriginsEqual(projected.requesterOrigin, requesterOrigin))
    ) {
      throw new Error(`Workboard card ${params.card.id} has a mismatched managed-flow requester`);
    }
    if (matching.length === 1 && matching[0]?.flowId !== projected.flowId) {
      throw new Error(`multiple managed TaskFlows match Workboard card ${params.card.id}`);
    }
    flow = projected;
  } else if (matching[0]) {
    // This is the flow-create -> card-CAS crash window. Reuse the exact durable
    // flow instead of creating a second controller record.
    flow = matching[0];
  } else {
    const now = params.now ?? Date.now();
    flow = runtime.createManaged({
      controllerId: WORKBOARD_CONTROLLER_ID,
      goal: params.card.title,
      status: "running",
      notifyPolicy: "silent",
      currentStep: "starting",
      stateJson: flowState(params.card, "starting"),
      createdAt: now,
      updatedAt: now,
    });
  }
  assertExactCardFlow(flow, params.card);
  if (
    flow.ownerKey !== ownerSessionKey ||
    (requesterOrigin && !requesterOriginsEqual(flow.requesterOrigin, requesterOrigin))
  ) {
    throw new Error(`managed TaskFlow ${flow.flowId} has a mismatched Workboard requester`);
  }
  const card = await projectFlow({
    store: params.store,
    cardId: params.card.id,
    flow,
    ownerSessionKey,
  });
  return { card, context: { flow, runtime, workerSessionKey, ownerSessionKey } };
}

export async function waitWorkboardManagedFlowForWorker(params: {
  store: WorkboardStore;
  card: WorkboardCard;
  context: WorkboardManagedFlowContext;
  workerSessionKey: string;
  runId: string;
  now?: number;
}): Promise<WorkboardCard> {
  for (let attempt = 0; attempt < MAX_FLOW_REVISION_RETRIES; attempt += 1) {
    const current = params.context.runtime.get(params.context.flow.flowId);
    if (!current) {
      throw new Error(`managed TaskFlow ${params.context.flow.flowId} disappeared`);
    }
    assertExactCardFlow(current, params.card);
    const wait = readRecord(current.waitJson);
    if (
      current.status === "waiting" &&
      wait?.kind === "workboard_worker" &&
      wait.cardId === params.card.id &&
      wait.runId === params.runId
    ) {
      return await projectFlow({
        store: params.store,
        cardId: params.card.id,
        flow: current,
        ownerSessionKey: params.context.ownerSessionKey,
      });
    }
    if (
      current.status === "succeeded" ||
      current.status === "failed" ||
      current.status === "cancelled" ||
      current.status === "lost"
    ) {
      throw new Error(`managed TaskFlow ${current.flowId} is already terminal (${current.status})`);
    }
    const updated = params.context.runtime.setWaiting({
      flowId: current.flowId,
      expectedRevision: current.revision,
      currentStep: "worker",
      stateJson: flowState(params.card, "waiting_worker", params.runId),
      waitJson: {
        schema: WORKBOARD_FLOW_SCHEMA,
        kind: "workboard_worker",
        cardId: params.card.id,
        sessionKey: params.workerSessionKey,
        runId: params.runId,
        wakeOn: "subagent_ended",
      },
      blockedSummary: `Waiting for Workboard worker run ${params.runId}.`,
      updatedAt: params.now ?? Date.now(),
    });
    if (updated.applied) {
      return await projectFlow({
        store: params.store,
        cardId: params.card.id,
        flow: updated.flow,
        ownerSessionKey: params.context.ownerSessionKey,
      });
    }
    if (updated.code !== "revision_conflict") {
      throw new Error(`could not wait managed TaskFlow ${current.flowId}: ${updated.code}`);
    }
  }
  throw new Error(`managed TaskFlow ${params.context.flow.flowId} kept changing during wait`);
}

export async function resumeWorkboardManagedFlowForWorker(params: {
  store: WorkboardStore;
  card: WorkboardCard;
  context: WorkboardManagedFlowContext;
  runId: string;
  now?: number;
}): Promise<WorkboardCard> {
  for (let attempt = 0; attempt < MAX_FLOW_REVISION_RETRIES; attempt += 1) {
    const current = params.context.runtime.get(params.context.flow.flowId);
    if (!current) {
      throw new Error(`managed TaskFlow ${params.context.flow.flowId} disappeared`);
    }
    assertExactCardFlow(current, params.card);
    if (current.status === "running" || current.status === "queued") {
      return await projectFlow({
        store: params.store,
        cardId: params.card.id,
        flow: current,
        ownerSessionKey: params.context.ownerSessionKey,
      });
    }
    if (
      current.status === "succeeded" ||
      current.status === "failed" ||
      current.status === "cancelled" ||
      current.status === "lost"
    ) {
      throw new Error(`managed TaskFlow ${current.flowId} is already terminal (${current.status})`);
    }
    const updated = params.context.runtime.resume({
      flowId: current.flowId,
      expectedRevision: current.revision,
      status: "running",
      currentStep: "starting",
      stateJson: flowState(params.card, "starting", params.runId),
      updatedAt: params.now ?? Date.now(),
    });
    if (updated.applied) {
      return await projectFlow({
        store: params.store,
        cardId: params.card.id,
        flow: updated.flow,
        ownerSessionKey: params.context.ownerSessionKey,
      });
    }
    if (updated.code !== "revision_conflict") {
      throw new Error(`could not resume managed TaskFlow ${current.flowId}: ${updated.code}`);
    }
  }
  throw new Error(`managed TaskFlow ${params.context.flow.flowId} kept changing during resume`);
}

function blockedCardSummary(card: WorkboardCard): string {
  return (
    card.metadata?.comments?.at(-1)?.body?.trim() ||
    card.metadata?.notifications?.at(-1)?.message?.trim() ||
    "Workboard card blocked."
  );
}

export async function settleBlockedWorkboardManagedFlow(params: {
  store: WorkboardStore;
  card: WorkboardCard;
  managedFlows: WorkboardManagedFlowsRuntime;
  now?: number;
}): Promise<WorkboardCard> {
  const automation = params.card.metadata?.automation;
  if (!automation?.flowId && !automation?.flowOwnerSessionKey && !automation?.controllerId) {
    return params.card;
  }
  if (
    params.card.status !== "blocked" ||
    params.card.metadata?.claim ||
    !automation?.flowId ||
    !automation.flowOwnerSessionKey ||
    automation.flowRevision === undefined ||
    automation.controllerId !== WORKBOARD_CONTROLLER_ID ||
    automation.completionDelivery
  ) {
    throw new Error("blocked Workboard card has an incomplete managed TaskFlow projection");
  }
  const ownerSessionKey = automation.flowOwnerSessionKey;
  const runtime = params.managedFlows.bindSession({ sessionKey: ownerSessionKey });
  const runId = params.card.runId ?? params.card.execution?.runId;
  const summary = blockedCardSummary(params.card);
  const now = params.now ?? Date.now();
  for (let attempt = 0; attempt < MAX_FLOW_REVISION_RETRIES; attempt += 1) {
    const current = runtime.get(automation.flowId);
    if (!current) {
      throw new Error(`managed TaskFlow ${automation.flowId} disappeared`);
    }
    assertExactCardFlow(current, params.card);
    if (current.ownerKey !== ownerSessionKey) {
      throw new Error(`managed TaskFlow ${current.flowId} has a mismatched Workboard requester`);
    }
    if (current.status === "failed") {
      return await params.store.detachBlockedManagedFlow(params.card.id, {
        flowId: current.flowId,
        flowOwnerSessionKey: ownerSessionKey,
        flowRevision: current.revision,
        controllerId: WORKBOARD_CONTROLLER_ID,
      });
    }
    if (
      current.status === "succeeded" ||
      current.status === "cancelled" ||
      current.status === "lost"
    ) {
      throw new Error(
        `managed TaskFlow ${current.flowId} reached conflicting terminal status ${current.status}`,
      );
    }
    const result = runtime.fail({
      flowId: current.flowId,
      expectedRevision: current.revision,
      stateJson: flowState(params.card, "failed", runId),
      blockedSummary: summary,
      updatedAt: now,
      endedAt: now,
    });
    if (result.applied) {
      return await params.store.detachBlockedManagedFlow(params.card.id, {
        flowId: result.flow.flowId,
        flowOwnerSessionKey: ownerSessionKey,
        flowRevision: result.flow.revision,
        controllerId: WORKBOARD_CONTROLLER_ID,
      });
    }
    if (result.code !== "revision_conflict") {
      throw new Error(`could not fail managed TaskFlow ${current.flowId}: ${result.code}`);
    }
  }
  throw new Error(`managed TaskFlow ${automation.flowId} kept changing during block settlement`);
}
