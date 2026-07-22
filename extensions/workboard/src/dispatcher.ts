// Workboard plugin module implements dispatcher behavior.
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import {
  ensureWorkboardManagedFlow,
  resumeWorkboardManagedFlowForWorker,
  settleBlockedWorkboardManagedFlow,
  waitWorkboardManagedFlowForWorker,
  type WorkboardManagedFlowContext,
  type WorkboardManagedFlowsRuntime,
} from "./managed-flow.js";
import { WorkboardStore, type WorkboardDispatchResult } from "./store.js";
import type {
  WorkboardCard,
  WorkboardExecution,
  WorkboardRequesterOrigin,
  WorkboardWorkspace,
} from "./types.js";

const DEFAULT_DISPATCH_MAX_STARTS = 3;
const DEFAULT_DISPATCH_OWNER = "workboard-dispatcher";
const DEFAULT_DISPATCH_MODEL = "default";
const DEFAULT_DISPATCH_MAX_RETRIES = 2;

export type WorkboardSubagentRuntime = Pick<PluginRuntime["subagent"], "run">;
export type WorkboardRecoveryRuntime = Pick<
  PluginRuntime["subagent"],
  "run" | "waitForRun" | "getRecoveryOwnership" | "getRunState"
>;
export type WorkboardSessionRuntime = Pick<PluginRuntime["agent"]["session"], "getSessionEntry">;
export type WorkboardWorktreeRuntime = PluginRuntime["worktrees"];

type WorkboardDispatchStartOptions = {
  maxStarts?: number;
  model?: string;
  provider?: string;
  ownerId?: string;
  boardId?: string;
  now?: number;
  allowManagedWorktrees?: boolean;
  candidateCardIds?: ReadonlySet<string>;
  ignoredOwnerSlotCardIds?: ReadonlySet<string>;
  recoveryMode?: boolean;
  requesterSessionKey?: string;
  /** Trusted client policy; raw clients may only select the fixed canonical mode. */
  canonicalOwnerForRouteLess?: boolean;
  /** Trusted host policy hook. Never populate this from raw Gateway input. */
  resolveRequesterRouteForCard?: (
    card: WorkboardCard,
    proposedWorkerSessionKey: string,
  ) => Promise<{ workerSessionKey: string; ownerSessionKey: string; workspaceDir: string }>;
  requesterOrigin?: WorkboardRequesterOrigin;
  requesterWorkspace?: string;
};

type WorkboardStartedRun = {
  cardId: string;
  title: string;
  sessionKey: string;
  runId: string;
};

type WorkboardStartFailure = {
  cardId: string;
  title: string;
  error: string;
};

type WorkboardDispatchAndStartResult = WorkboardDispatchResult & {
  started: WorkboardStartedRun[];
  startFailures: WorkboardStartFailure[];
  needsReconciliation: boolean;
};

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : fallback;
}

function cardBoardId(card: WorkboardCard): string {
  return card.metadata?.automation?.boardId ?? "default";
}

function sanitizeSessionSegment(value: string | undefined, fallback: string): string {
  const sanitized = (value ?? fallback)
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (sanitized || fallback).slice(0, 96);
}

function cardIsArchived(card: WorkboardCard): boolean {
  return Boolean(card.metadata?.archivedAt);
}

function buildSessionKey(card: WorkboardCard): string {
  const boardId = sanitizeSessionSegment(cardBoardId(card), "default");
  const cardId = sanitizeSessionSegment(card.id, "card");
  const suffix = `subagent:workboard-${boardId}-${cardId}`;
  const flowOwnerSessionKey =
    card.metadata?.automation?.flowOwnerSessionKey ??
    card.metadata?.automation?.requesterSessionKey;
  const agentId = card.agentId ?? parseAgentSessionKey(flowOwnerSessionKey)?.agentId;
  return agentId ? `agent:${sanitizeSessionSegment(agentId, "agent")}:${suffix}` : suffix;
}

function resolveDispatchOwnerId(params: {
  card: WorkboardCard;
  workerSessionKey: string;
  explicitOwnerId?: string;
}): string {
  return (
    params.explicitOwnerId?.trim() ||
    params.card.agentId ||
    parseAgentSessionKey(params.workerSessionKey)?.agentId ||
    DEFAULT_DISPATCH_OWNER
  );
}

function buildExecution(params: {
  card: WorkboardCard;
  sessionKey: string;
  runId: string;
  model: string;
  now: number;
}): WorkboardExecution {
  return {
    id: params.card.execution?.id ?? `${params.card.id}:codex`,
    kind: "agent-session",
    engine: "codex",
    mode: "autonomous",
    status: "running",
    model: params.model,
    sessionKey: params.sessionKey,
    runId: params.runId,
    startedAt: params.now,
    updatedAt: params.now,
  };
}

function managedWorktreeName(cardId: string): string {
  const suffix = cardId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-");
  return `wb-${suffix}`.slice(0, 64).replace(/-$/, "");
}

async function materializeWorkspace(params: {
  card: WorkboardCard;
  worktrees?: WorkboardWorktreeRuntime;
  allowManagedWorktrees: boolean;
}): Promise<{ workspace?: WorkboardWorkspace; cwd?: string }> {
  const automation = params.card.metadata?.automation;
  const workspace = automation?.workspace;
  if (workspace?.kind !== "worktree") {
    const cwd = workspace?.path ?? automation?.requesterWorkspace;
    if (!cwd) {
      return workspace ? { workspace } : {};
    }
    if (!path.isAbsolute(cwd)) {
      throw new Error("workflow workspace path must be absolute");
    }
    return {
      cwd,
      ...(workspace ? { workspace } : {}),
    };
  }
  if (!params.allowManagedWorktrees) {
    throw new Error("managed worktree dispatch requires operator.admin");
  }
  const sourcePath = workspace.sourcePath ?? workspace.path;
  const sourceBranch = workspace.sourcePath ? workspace.sourceBranch : workspace.branch;
  if (!sourcePath || !path.isAbsolute(sourcePath)) {
    throw new Error("worktree workspace path must be an absolute git checkout path");
  }
  if (!params.worktrees) {
    throw new Error("managed worktree runtime is unavailable");
  }
  const worktree = await params.worktrees.create({
    repoRoot: sourcePath,
    name: managedWorktreeName(params.card.id),
    ...(sourceBranch ? { baseRef: sourceBranch } : {}),
    ownerKind: "workboard",
    ownerId: params.card.id,
  });
  return {
    cwd: worktree.path,
    workspace: {
      kind: "worktree",
      path: worktree.path,
      branch: worktree.branch,
      sourcePath,
      ...(sourceBranch ? { sourceBranch } : {}),
    },
  };
}

function buildWorkerPrompt(params: {
  card: WorkboardCard;
  context: string;
  ownerId: string;
  token: string;
}): string {
  return [
    `Work on this OpenClaw Workboard card: ${params.card.title}`,
    "",
    "## Worker protocol",
    `Card id: ${params.card.id}`,
    `Claim ownerId: ${params.ownerId}`,
    `Claim token: ${params.token}`,
    "",
    "Heartbeat with workboard_heartbeat using the card id and token while working.",
    "When done, call workboard_complete with the card id, token, summary, passed proof, and a readable absolute local artifact file path (a URL may be supplemental).",
    "If blocked, call workboard_block with the card id, token, and reason.",
    "",
    params.context,
  ].join("\n");
}

function sortReadyCards(a: WorkboardCard, b: WorkboardCard): number {
  const priorityRank: Record<WorkboardCard["priority"], number> = {
    urgent: 0,
    high: 1,
    normal: 2,
    low: 3,
  };
  return (
    priorityRank[a.priority] - priorityRank[b.priority] ||
    a.position - b.position ||
    a.createdAt - b.createdAt
  );
}

function selectStartableCards(
  cards: WorkboardCard[],
  limit: number,
  candidates: WorkboardCard[] = cards,
  ignoredOwnerSlotCardIds?: ReadonlySet<string>,
): WorkboardCard[] {
  if (limit <= 0) {
    return [];
  }
  const runningByOwner = new Map<string, number>();
  for (const card of cards) {
    if (ignoredOwnerSlotCardIds?.has(card.id)) {
      continue;
    }
    const consumesOwnerSlot =
      card.status === "running" ||
      Boolean(card.metadata?.claim) ||
      card.execution?.status === "running";
    if (!consumesOwnerSlot || cardIsArchived(card)) {
      continue;
    }
    const owner = card.agentId ?? DEFAULT_DISPATCH_OWNER;
    runningByOwner.set(owner, (runningByOwner.get(owner) ?? 0) + 1);
  }
  const selected: WorkboardCard[] = [];
  for (const card of candidates
    .filter((entry) => entry.status === "ready" && !entry.metadata?.claim && !cardIsArchived(entry))
    .toSorted(sortReadyCards)) {
    const owner = card.agentId ?? DEFAULT_DISPATCH_OWNER;
    if ((runningByOwner.get(owner) ?? 0) > 0) {
      continue;
    }
    selected.push(card);
    runningByOwner.set(owner, 1);
    if (selected.length >= limit) {
      break;
    }
  }
  return selected;
}

export async function dispatchAndStartWorkboardCards(params: {
  store: WorkboardStore;
  subagent: WorkboardSubagentRuntime;
  managedFlows?: WorkboardManagedFlowsRuntime;
  worktrees?: WorkboardWorktreeRuntime;
  options?: WorkboardDispatchStartOptions;
}): Promise<WorkboardDispatchAndStartResult> {
  const now = params.options?.now ?? Date.now();
  const boardId = params.options?.boardId;
  const dispatch = await params.store.dispatch({ now, boardId });
  const maxStarts = normalizePositiveInteger(
    params.options?.maxStarts,
    DEFAULT_DISPATCH_MAX_STARTS,
  );
  const started: WorkboardStartedRun[] = [];
  const startFailures: WorkboardStartFailure[] = [];
  let needsReconciliation = false;
  const model = params.options?.model?.trim() || DEFAULT_DISPATCH_MODEL;
  const cards = await params.store.list();
  const candidateCardIds = params.options?.candidateCardIds;
  const candidates = (await params.store.list({ boardId })).filter(
    (card) => !candidateCardIds || candidateCardIds.has(card.id),
  );

  for (const candidateCard of selectStartableCards(
    cards,
    maxStarts,
    candidates,
    params.options?.ignoredOwnerSlotCardIds,
  )) {
    let card = candidateCard;
    let sessionKey = buildSessionKey(card);
    let ownerId = resolveDispatchOwnerId({
      card,
      workerSessionKey: sessionKey,
      explicitOwnerId: params.options?.ownerId,
    });
    let token = "";
    let materializedWorkspace: WorkboardWorkspace | undefined;
    let managedFlowContext: WorkboardManagedFlowContext | undefined;
    let runInvoked = false;
    try {
      const automation = card.metadata?.automation;
      const useCanonicalOwnerPolicy =
        !automation?.requesterSessionKey &&
        (automation?.requesterOwnerMode === "canonical_main_no_origin" ||
          params.options?.canonicalOwnerForRouteLess === true);
      const policyRoute = useCanonicalOwnerPolicy
        ? await params.options?.resolveRequesterRouteForCard?.(card, sessionKey)
        : undefined;
      if (useCanonicalOwnerPolicy && !policyRoute) {
        throw new Error("canonical Workboard owner route is unavailable");
      }
      const policyWorkerSessionKey = policyRoute?.workerSessionKey.trim();
      const policyWorkerAgentId = parseAgentSessionKey(policyWorkerSessionKey)?.agentId;
      const requesterSessionKey =
        policyRoute?.ownerSessionKey.trim() || params.options?.requesterSessionKey?.trim();
      const requesterWorkspace =
        policyRoute?.workspaceDir.trim() || params.options?.requesterWorkspace?.trim();
      if (
        policyRoute &&
        (!policyWorkerSessionKey ||
          !policyWorkerAgentId ||
          !requesterSessionKey ||
          !requesterWorkspace ||
          !path.isAbsolute(requesterWorkspace))
      ) {
        throw new Error("canonical Workboard owner resolution returned an incomplete route");
      }
      sessionKey = policyWorkerSessionKey || sessionKey;
      ownerId = resolveDispatchOwnerId({
        card,
        workerSessionKey: sessionKey,
        explicitOwnerId: params.options?.ownerId,
      });
      if (params.managedFlows && !card.metadata?.automation?.flowId && requesterSessionKey) {
        card = await params.store.bindManagedFlowRequester(card.id, {
          requesterSessionKey,
          ...(params.options?.requesterSessionKey
            ? {
                requesterOrigin: params.options.requesterOrigin,
              }
            : {}),
          ...(requesterWorkspace ? { requesterWorkspace } : {}),
        });
        sessionKey = policyWorkerSessionKey || buildSessionKey(card);
        ownerId = resolveDispatchOwnerId({
          card,
          workerSessionKey: sessionKey,
          explicitOwnerId: params.options?.ownerId,
        });
      }
      if (
        card.metadata?.automation?.workspace?.kind === "worktree" &&
        params.options?.allowManagedWorktrees === false &&
        !params.options?.recoveryMode
      ) {
        throw new Error("managed worktree dispatch requires operator.admin");
      }
      const startIdempotencyKey =
        card.metadata?.automation?.startIdempotencyKey ??
        `workboard:${card.id}:start:${card.events?.at(-1)?.id ?? card.updatedAt}`;
      const workflowIdempotencyKey =
        card.metadata?.automation?.idempotencyKey ?? `workboard:${card.id}:workflow`;
      if (params.managedFlows) {
        const managed = await ensureWorkboardManagedFlow({
          store: params.store,
          card,
          workerSessionKey: sessionKey,
          managedFlows: params.managedFlows,
          now,
        });
        managedFlowContext = managed.context;
        sessionKey = managed.context.workerSessionKey;
      }
      const claimed = await params.store.claimForDispatch(
        card.id,
        {
          ownerId,
          ttlSeconds: card.metadata?.automation?.maxRuntimeSeconds,
        },
        {
          ownerSlotId: ownerId,
          ignoredOwnerSlotCardIds: params.options?.ignoredOwnerSlotCardIds,
          startIdempotencyKey,
          startSessionKey: sessionKey,
          startModel: model,
          startProvider: params.options?.provider,
          workflowIdempotencyKey,
          maxRetries: card.metadata?.automation?.maxRetries ?? DEFAULT_DISPATCH_MAX_RETRIES,
        },
      );
      token = claimed.token;
      let preparedCard = claimed.card;
      if (managedFlowContext) {
        preparedCard = await resumeWorkboardManagedFlowForWorker({
          store: params.store,
          card: preparedCard,
          context: managedFlowContext,
          runId: startIdempotencyKey,
          now,
        });
      }
      const context = await params.store.buildWorkerContext(card.id);
      const materialized = await materializeWorkspace({
        card: preparedCard,
        worktrees: params.worktrees,
        allowManagedWorktrees: params.options?.allowManagedWorktrees !== false,
      });
      materializedWorkspace = materialized.workspace;
      if (materializedWorkspace) {
        await params.store.updateDispatchWorkspace(card.id, materializedWorkspace);
      }
      runInvoked = true;
      const run = await params.subagent.run({
        sessionKey,
        message: buildWorkerPrompt({
          card: preparedCard,
          context,
          ownerId,
          token,
        }),
        ...(params.options?.provider ? { provider: params.options.provider } : {}),
        ...(params.options?.model ? { model: params.options.model } : {}),
        lane: `workboard:${cardBoardId(card)}:${card.id}`,
        idempotencyKey: startIdempotencyKey,
        lightContext: true,
        deliver: false,
        ...(managedFlowContext
          ? {
              parentFlowId: managedFlowContext.flow.flowId,
              flowOwnerSessionKey: managedFlowContext.ownerSessionKey,
            }
          : {}),
        ...(materialized.cwd ? { cwd: materialized.cwd } : {}),
      });
      let updated = await params.store.recordStartedWorker(card.id, {
        ownerId,
        token,
        sessionKey,
        runId: run.runId,
        execution: buildExecution({
          card: preparedCard,
          sessionKey,
          runId: run.runId,
          model,
          now,
        }),
      });
      if (managedFlowContext) {
        updated = await waitWorkboardManagedFlowForWorker({
          store: params.store,
          card: updated,
          context: managedFlowContext,
          workerSessionKey: sessionKey,
          runId: run.runId,
          now,
        });
      }
      await params.store.addWorkerLog(
        updated.id,
        {
          level: "info",
          message: `Dispatcher started subagent run ${run.runId}.`,
          sessionKey,
          runId: run.runId,
        },
        { ownerId, token },
      );
      started.push({
        cardId: updated.id,
        title: updated.title,
        sessionKey,
        runId: run.runId,
      });
    } catch (error) {
      if (!runInvoked && materializedWorkspace?.path && params.worktrees) {
        await params.worktrees
          .removeIfLossless({ path: materializedWorkspace.path })
          .catch(() => undefined);
        const sourceWorkspace = card.metadata?.automation?.workspace;
        if (sourceWorkspace) {
          await params.store
            .updateDispatchWorkspace(card.id, sourceWorkspace)
            .catch(() => undefined);
        }
      }
      const message = formatErrorMessage(error);
      startFailures.push({ cardId: card.id, title: card.title, error: message });
      if (!token) {
        continue;
      }
      try {
        if (runInvoked) {
          needsReconciliation = true;
          // The runtime accepted this successor. Preserve its claim and
          // workspace when the RPC outcome or run-mapping persistence is
          // ambiguous. Startup reconciliation resolves the durable
          // idempotency key before retrying or releasing anything.
        } else if (params.options?.recoveryMode) {
          await params.store.recordRecoveryStartFailure(card.id, {
            ownerId,
            token,
            reason: `Dispatcher could not start recovery worker: ${message}`,
            maxAttempts: 3,
          });
        } else {
          await params.store.block(
            card.id,
            {
              ownerId,
              token,
              reason: `Dispatcher could not start worker: ${message}`,
            },
            { ownerId, token },
          );
        }
      } catch {
        // Leave the original start failure visible; dispatch will diagnose stale claims later.
      }
    }
  }

  return {
    ...dispatch,
    started,
    startFailures,
    needsReconciliation,
    count: dispatch.count + started.length + startFailures.length,
  };
}

const RESTART_INTERRUPTED_CODEX_BRIDGE_ERROR_RE =
  /\bcodex app-server (?:client|turn route) closed before turn completed\b/iu;
const RESTART_INTERRUPTED_GATEWAY_CLOSE_ERROR_RE = /\bgateway closed \(1012\): service restart\b/iu;
const LOST_ACTIVE_EXECUTION_CONTEXT_ERROR = "subagent run lost active execution context";
const TERMINAL_SETTLEMENT_MAX_ATTEMPTS = 3;

export function isRecoverableWorkerInterruption(error: string | undefined): boolean {
  const detail = error?.trim() ?? "";
  return (
    RESTART_INTERRUPTED_CODEX_BRIDGE_ERROR_RE.test(detail) ||
    RESTART_INTERRUPTED_GATEWAY_CLOSE_ERROR_RE.test(detail) ||
    detail === LOST_ACTIVE_EXECUTION_CONTEXT_ERROR
  );
}

export type WorkboardTerminalRunEvent = {
  targetSessionKey: string;
  runId?: string;
  outcome?: "ok" | "error" | "timeout" | "killed" | "reset" | "deleted";
  error?: string;
};

export type WorkboardTerminalSettlementResult = {
  status:
    | "settled"
    | "already-terminal"
    | "completion-owned"
    | "superseded"
    | "unmanaged"
    | "recoverable"
    | "retry-exhausted";
  card?: WorkboardCard;
  error?: string;
};

type PendingStartReconciliation = {
  mapped?: WorkboardStartedRun;
  pending: boolean;
  continuation?: "bounded" | "durable";
  failure?: WorkboardStartFailure;
};

async function waitManagedFlowForExistingRun(params: {
  store: WorkboardStore;
  subagent: WorkboardRecoveryRuntime;
  managedFlows?: WorkboardManagedFlowsRuntime;
  card: WorkboardCard;
  workerSessionKey: string;
  runId: string;
  now: number;
}): Promise<WorkboardCard> {
  if (!params.managedFlows) {
    return params.card;
  }
  const managed = await ensureWorkboardManagedFlow({
    store: params.store,
    card: params.card,
    workerSessionKey: params.workerSessionKey,
    managedFlows: params.managedFlows,
    now: params.now,
  });
  if (managed.context.workerSessionKey !== params.workerSessionKey) {
    throw new Error("Workboard run does not use the canonical worker session key");
  }
  return await waitWorkboardManagedFlowForWorker({
    store: params.store,
    card: managed.card,
    context: managed.context,
    workerSessionKey: params.workerSessionKey,
    runId: params.runId,
    now: params.now,
  });
}

async function reconcilePendingWorkerStart(params: {
  store: WorkboardStore;
  subagent: WorkboardRecoveryRuntime;
  managedFlows?: WorkboardManagedFlowsRuntime;
  card: WorkboardCard;
  now: number;
  tryReserveStart: () => boolean;
  worktrees?: WorkboardWorktreeRuntime;
  allowManagedWorktrees: boolean;
}): Promise<PendingStartReconciliation> {
  const automation = params.card.metadata?.automation;
  const claim = params.card.metadata?.claim;
  const runId = automation?.startIdempotencyKey;
  const sessionKey = automation?.startSessionKey;
  if (!claim || !runId || !sessionKey) {
    return { pending: false };
  }
  let recoveryCard = params.card;
  let managedFlowContext: WorkboardManagedFlowContext | undefined;
  if (params.managedFlows) {
    const managed = await ensureWorkboardManagedFlow({
      store: params.store,
      card: recoveryCard,
      workerSessionKey: sessionKey,
      managedFlows: params.managedFlows,
      now: params.now,
    });
    if (managed.context.workerSessionKey !== sessionKey) {
      throw new Error("pending Workboard start does not use the canonical worker session key");
    }
    recoveryCard = managed.card;
    managedFlowContext = managed.context;
  }

  const mapAcceptedRun = async (
    state: Awaited<ReturnType<WorkboardRecoveryRuntime["getRunState"]>>,
  ): Promise<PendingStartReconciliation> => {
    let updated = await params.store.recordStartedWorker(recoveryCard.id, {
      ownerId: claim.ownerId,
      token: claim.token,
      sessionKey,
      runId,
      execution: buildExecution({
        card: recoveryCard,
        sessionKey,
        runId,
        model: automation?.startModel ?? params.card.execution?.model ?? DEFAULT_DISPATCH_MODEL,
        now: params.now,
      }),
    });
    if (managedFlowContext) {
      updated = await waitWorkboardManagedFlowForWorker({
        store: params.store,
        card: updated,
        context: managedFlowContext,
        workerSessionKey: sessionKey,
        runId,
        now: params.now,
      });
    }
    if (state.status === "terminal") {
      if (state.outcome === "error" && isRecoverableWorkerInterruption(state.error)) {
        // The accepted run can terminate during the response-loss window. Its
        // original subagent_ended event may already be gone, so force another
        // durable pass to reconcile core restart ownership for this exact run.
        return { pending: true, continuation: "durable" };
      }
      const settlement = await settleTerminatedWorkboardRun({
        store: params.store,
        subagent: params.subagent,
        event: {
          targetSessionKey: sessionKey,
          runId,
          outcome: state.outcome,
          error: state.error,
        },
      });
      if (
        params.worktrees &&
        (settlement.status === "settled" || settlement.status === "already-terminal")
      ) {
        await cleanupWorkboardRunWorktree({
          store: params.store,
          worktrees: params.worktrees,
          runId,
          sessionKey,
        });
      }
      return settlement.status === "retry-exhausted"
        ? {
            pending: true,
            continuation: "durable",
            failure: {
              cardId: updated.id,
              title: updated.title,
              error: settlement.error ?? "terminal worker settlement is still pending",
            },
          }
        : { pending: false };
    }
    await params.store.addWorkerLog(
      updated.id,
      {
        level: "info",
        message: `Reconciled accepted subagent run ${runId} after its start response was lost.`,
        sessionKey,
        runId,
      },
      { ownerId: claim.ownerId, token: claim.token },
    );
    return {
      pending: false,
      mapped: { cardId: updated.id, title: updated.title, sessionKey, runId },
    };
  };

  let state;
  try {
    state = await params.subagent.getRunState({ sessionKey, runId });
  } catch (error) {
    return {
      pending: true,
      continuation: "durable",
      failure: {
        cardId: params.card.id,
        title: params.card.title,
        error: formatErrorMessage(error),
      },
    };
  }
  if (state.status === "active" || state.status === "terminal") {
    return await mapAcceptedRun(state);
  }
  if (state.status === "unknown") {
    return { pending: true, continuation: "durable" };
  }
  if (!params.tryReserveStart()) {
    return { pending: true, continuation: "bounded" };
  }

  try {
    if (managedFlowContext) {
      recoveryCard = await resumeWorkboardManagedFlowForWorker({
        store: params.store,
        card: recoveryCard,
        context: managedFlowContext,
        runId,
        now: params.now,
      });
    }
    const materialized = await materializeWorkspace({
      card: recoveryCard,
      worktrees: params.worktrees,
      allowManagedWorktrees: params.allowManagedWorktrees,
    });
    if (materialized.workspace) {
      await params.store.updateDispatchWorkspace(params.card.id, materialized.workspace);
    }
    const context = await params.store.buildWorkerContext(params.card.id);
    const result = await params.subagent.run({
      sessionKey,
      message: buildWorkerPrompt({
        card: params.card,
        context,
        ownerId: claim.ownerId,
        token: claim.token,
      }),
      ...(automation?.startProvider ? { provider: automation.startProvider } : {}),
      ...(automation?.startModel ? { model: automation.startModel } : {}),
      lane: `workboard:${cardBoardId(params.card)}:${params.card.id}`,
      idempotencyKey: runId,
      lightContext: true,
      deliver: false,
      ...(managedFlowContext
        ? {
            parentFlowId: managedFlowContext.flow.flowId,
            flowOwnerSessionKey: managedFlowContext.ownerSessionKey,
          }
        : {}),
      ...(materialized.cwd ? { cwd: materialized.cwd } : {}),
    });
    if (result.runId !== runId) {
      throw new Error("subagent returned a run id that does not match the persisted start key");
    }
    return await mapAcceptedRun({ status: "active" });
  } catch (error) {
    const message = formatErrorMessage(error);
    try {
      const afterError = await params.subagent.getRunState({ sessionKey, runId });
      if (afterError.status === "active" || afterError.status === "terminal") {
        return await mapAcceptedRun(afterError);
      }
      if (afterError.status === "absent") {
        const card = await params.store.recordPendingStartFailure(params.card.id, {
          ownerId: claim.ownerId,
          token: claim.token,
          reason: `Dispatcher could not start worker: ${message}`,
          maxAttempts: 3,
        });
        const workspace = card.metadata?.automation?.workspace;
        if (
          card.status === "blocked" &&
          workspace?.kind === "worktree" &&
          workspace.path &&
          params.worktrees
        ) {
          await params.worktrees.removeIfLossless({ path: workspace.path });
        }
        return {
          pending: card.status !== "blocked",
          ...(card.status !== "blocked" ? { continuation: "bounded" as const } : {}),
          failure: { cardId: card.id, title: card.title, error: message },
        };
      }
    } catch {
      // Unknown runtime state is fail-closed below. Keep the durable pending
      // start and its claim/worktree intact for a later reconciliation pass.
    }
    return {
      pending: true,
      continuation: "durable",
      failure: { cardId: params.card.id, title: params.card.title, error: message },
    };
  }
}

export async function settleTerminatedWorkboardRun(params: {
  store: WorkboardStore;
  subagent?: Pick<WorkboardRecoveryRuntime, "getRecoveryOwnership"> &
    Partial<Pick<WorkboardRecoveryRuntime, "getRunState">>;
  event: WorkboardTerminalRunEvent;
}): Promise<WorkboardTerminalSettlementResult> {
  if (isRecoverableWorkerInterruption(params.event.error)) {
    return { status: "recoverable" };
  }
  let lastError: string | undefined;
  for (let attempt = 0; attempt < TERMINAL_SETTLEMENT_MAX_ATTEMPTS; attempt += 1) {
    const cards = await params.store.list();
    const card = params.event.runId
      ? cards.find((entry) => (entry.runId ?? entry.execution?.runId) === params.event.runId)
      : cards.find(
          (entry) =>
            (entry.sessionKey ?? entry.execution?.sessionKey) === params.event.targetSessionKey,
        );
    if (!card) {
      const sameSession = params.event.runId
        ? cards.find(
            (entry) =>
              (entry.sessionKey ?? entry.execution?.sessionKey) === params.event.targetSessionKey,
          )
        : undefined;
      if (sameSession && params.event.runId && params.subagent) {
        const currentRunId = sameSession.runId ?? sameSession.execution?.runId;
        const revision = sameSession.events?.at(-1)?.id;
        if (currentRunId && revision) {
          try {
            const eventOwnership = await params.subagent.getRecoveryOwnership({
              sessionKey: params.event.targetSessionKey,
              runId: params.event.runId,
            });
            if (
              eventOwnership.status === "successor" &&
              eventOwnership.successorRunId === currentRunId
            ) {
              return { status: "superseded", card: sameSession };
            }
            const currentOwnership = await params.subagent.getRecoveryOwnership({
              sessionKey: params.event.targetSessionKey,
              runId: currentRunId,
            });
            if (
              currentOwnership.status === "successor" &&
              currentOwnership.successorRunId === params.event.runId
            ) {
              const remapped = await params.store.remapRecoveredSuccessor(sameSession.id, {
                expectedRevision: revision,
                expectedRunId: currentRunId,
                sessionKey: params.event.targetSessionKey,
                successorRunId: params.event.runId,
              });
              if (remapped) {
                continue;
              }
              lastError = "card changed while mapping its recovered successor";
              continue;
            }
          } catch (error) {
            return {
              status: "retry-exhausted",
              card: sameSession,
              error: formatErrorMessage(error),
            };
          }
        }
      }
      return {
        status: sameSession ? "superseded" : "unmanaged",
        ...(sameSession ? { card: sameSession } : {}),
      };
    }
    const cardRunId = card.runId ?? card.execution?.runId;
    const cardSessionKey = card.sessionKey ?? card.execution?.sessionKey;
    if (params.subagent?.getRunState && cardRunId && cardSessionKey) {
      try {
        const state = await params.subagent.getRunState({
          sessionKey: cardSessionKey,
          runId: cardRunId,
        });
        if (state.verifiedCompletionIntent?.cardId === card.id) {
          // Core owns this exact terminal result until native requester
          // delivery is acknowledged (or terminally failed). Generic terminal
          // settlement must not block the card or clean its worktree during
          // the arm-to-Workboard-projection crash window.
          return { status: "completion-owned", card };
        }
      } catch (error) {
        return {
          status: "retry-exhausted",
          card,
          error: formatErrorMessage(error),
        };
      }
    }
    if (card.status !== "running" || card.execution?.status !== "running") {
      return { status: "already-terminal", card };
    }
    const revision = card.events?.at(-1)?.id;
    if (!revision) {
      return { status: "retry-exhausted", card, error: "card has no terminal revision" };
    }
    const outcome = params.event.outcome ?? "unknown";
    const errorSuffix = params.event.error?.trim() ? `: ${params.event.error.trim()}` : ".";
    try {
      const settled = await params.store.settleTerminatedWorker(card.id, {
        expectedRevision: revision,
        targetSessionKey: params.event.targetSessionKey,
        ...(params.event.runId ? { runId: params.event.runId } : {}),
        detail: `Worker terminated with outcome ${outcome} without completing or blocking its Workboard card${errorSuffix}`,
      });
      if (settled) {
        return { status: "settled", card: settled };
      }
    } catch (error) {
      lastError = formatErrorMessage(error);
    }
  }
  return { status: "retry-exhausted", ...(lastError ? { error: lastError } : {}) };
}

export async function reconcileInterruptedWorkboardCards(params: {
  store: WorkboardStore;
  subagent: WorkboardRecoveryRuntime;
  managedFlows?: WorkboardManagedFlowsRuntime;
  sessions: WorkboardSessionRuntime;
  worktrees?: WorkboardWorktreeRuntime;
  options?: Pick<WorkboardDispatchStartOptions, "now" | "allowManagedWorktrees">;
}): Promise<{
  reconciled: string[];
  started: WorkboardStartedRun[];
  failures: WorkboardStartFailure[];
  needsContinuation: boolean;
  continuationMode?: "bounded" | "durable";
}> {
  const reconciled: string[] = [];
  const started: WorkboardStartedRun[] = [];
  const failures: WorkboardStartFailure[] = [];
  const now = params.options?.now ?? Date.now();
  let continuationMode: "bounded" | "durable" | undefined;
  const requestContinuation = (mode: "bounded" | "durable"): void => {
    if (mode === "durable" || !continuationMode) {
      continuationMode = mode;
    }
  };

  if (params.managedFlows) {
    const blockedManagedCards = (await params.store.list()).filter((card) => {
      const automation = card.metadata?.automation;
      return Boolean(
        card.status === "blocked" &&
        automation?.controllerId === "workboard" &&
        automation.flowId &&
        !automation.completionDelivery,
      );
    });
    for (const card of blockedManagedCards) {
      try {
        const settled = await settleBlockedWorkboardManagedFlow({
          store: params.store,
          card,
          managedFlows: params.managedFlows,
          now,
        });
        if (!settled.metadata?.automation?.flowId) {
          reconciled.push(settled.id);
        }
      } catch (error) {
        failures.push({ cardId: card.id, title: card.title, error: formatErrorMessage(error) });
        requestContinuation("durable");
      }
    }
  }

  // A claim and start identity are committed in one CAS before the runtime is
  // invoked. Reconcile those markers first: they cover both a crashed caller
  // and an accepted run whose response or mapping write was lost.
  const initialCards = await params.store.list();
  const pendingStartCards = initialCards.filter((card) => {
    const automation = card.metadata?.automation;
    return Boolean(
      !card.metadata?.archivedAt &&
      card.metadata?.claim &&
      automation?.startIdempotencyKey &&
      automation.startSessionKey,
    );
  });
  let pendingStartBudget = DEFAULT_DISPATCH_MAX_STARTS;
  for (const card of pendingStartCards) {
    try {
      const result = await reconcilePendingWorkerStart({
        store: params.store,
        subagent: params.subagent,
        managedFlows: params.managedFlows,
        card,
        now,
        worktrees: params.worktrees,
        allowManagedWorktrees: params.options?.allowManagedWorktrees !== false,
        tryReserveStart: () => {
          if (pendingStartBudget <= 0) {
            return false;
          }
          pendingStartBudget -= 1;
          return true;
        },
      });
      if (result.mapped) {
        started.push(result.mapped);
        reconciled.push(card.id);
      }
      if (result.failure) {
        failures.push(result.failure);
      }
      if (result.pending) {
        requestContinuation(result.continuation ?? "durable");
      }
    } catch (error) {
      failures.push({ cardId: card.id, title: card.title, error: formatErrorMessage(error) });
      requestContinuation("durable");
    }
  }

  const cards = await params.store.list();
  const recoverable: Array<{
    card: WorkboardCard;
    runId: string;
    revision: string;
  }> = [];

  for (const card of cards) {
    const automation = card.metadata?.automation;
    const failureCount = card.metadata?.failureCount ?? 0;
    const sessionKey = card.sessionKey ?? card.execution?.sessionKey;
    const runId = card.runId ?? card.execution?.runId;
    const awaitingLocalRecoveryStart =
      card.status === "ready" &&
      card.execution?.status === "idle" &&
      automation?.recoveryRunId === runId;
    if (
      !automation?.idempotencyKey ||
      typeof automation.maxRetries !== "number" ||
      !sessionKey ||
      !runId ||
      (!awaitingLocalRecoveryStart &&
        (card.status !== "running" || card.execution?.status !== "running")) ||
      (awaitingLocalRecoveryStart && automation.maxRetries < failureCount)
    ) {
      continue;
    }

    const revision = card.events?.at(-1)?.id;
    if (awaitingLocalRecoveryStart && revision) {
      recoverable.push({ card, runId, revision });
      continue;
    }

    try {
      let ownership;
      try {
        ownership = await params.subagent.getRecoveryOwnership({ sessionKey, runId });
      } catch (error) {
        failures.push({ cardId: card.id, title: card.title, error: formatErrorMessage(error) });
        requestContinuation("durable");
        continue;
      }
      if (ownership.status === "core_owned") {
        if (ownership.error) {
          failures.push({ cardId: card.id, title: card.title, error: ownership.error });
        }
        requestContinuation("durable");
        continue;
      }

      if (ownership.status === "unknown") {
        const runState = await params.subagent.getRunState({ sessionKey, runId });
        if (runState.status === "active") {
          // A restored registry row can remain active until core detects that
          // its process-local execution context was lost. Keep watching ownership.
          requestContinuation("durable");
          continue;
        }
        if (runState.status !== "terminal") {
          requestContinuation("durable");
          continue;
        }
        if (isRecoverableWorkerInterruption(runState.error)) {
          requestContinuation("durable");
          continue;
        }
        const settlement = await settleTerminatedWorkboardRun({
          store: params.store,
          subagent: params.subagent,
          event: {
            targetSessionKey: sessionKey,
            runId,
            outcome: runState.outcome,
            error: runState.error,
          },
        });
        if (settlement.status === "retry-exhausted") {
          requestContinuation("durable");
          failures.push({
            cardId: card.id,
            title: card.title,
            error: settlement.error ?? "terminal worker settlement is still pending",
          });
        } else if (
          params.worktrees &&
          (settlement.status === "settled" || settlement.status === "already-terminal")
        ) {
          await cleanupWorkboardRunWorktree({
            store: params.store,
            worktrees: params.worktrees,
            runId,
            sessionKey,
          });
        }
        continue;
      }

      if (ownership.status === "successor") {
        const successorRunId = ownership.successorRunId?.trim();
        if (!successorRunId) {
          failures.push({
            cardId: card.id,
            title: card.title,
            error: "core recovery reported a successor without its exact run id",
          });
          requestContinuation("durable");
          continue;
        }
        const latest = await params.store.get(card.id);
        const latestRevision = latest?.events?.at(-1)?.id;
        const latestRunId = latest?.runId ?? latest?.execution?.runId;
        if (
          !latest ||
          latest.status !== "running" ||
          latest.execution?.status !== "running" ||
          latestRunId !== runId ||
          !latestRevision
        ) {
          continue;
        }
        const remapped = await params.store.remapRecoveredSuccessor(latest.id, {
          expectedRevision: latestRevision,
          expectedRunId: runId,
          sessionKey,
          successorRunId,
        });
        if (!remapped) {
          requestContinuation("durable");
          continue;
        }
        reconciled.push(remapped.id);
        let successorState;
        try {
          successorState = await params.subagent.getRunState({
            sessionKey,
            runId: successorRunId,
          });
        } catch (error) {
          failures.push({ cardId: card.id, title: card.title, error: formatErrorMessage(error) });
          requestContinuation("durable");
          continue;
        }
        if (successorState.status === "active") {
          await waitManagedFlowForExistingRun({
            store: params.store,
            subagent: params.subagent,
            managedFlows: params.managedFlows,
            card: remapped,
            workerSessionKey: sessionKey,
            runId: successorRunId,
            now,
          });
          continue;
        }
        if (successorState.status === "terminal") {
          if (
            successorState.outcome === "error" &&
            isRecoverableWorkerInterruption(successorState.error)
          ) {
            requestContinuation("durable");
            continue;
          }
          const settlement = await settleTerminatedWorkboardRun({
            store: params.store,
            subagent: params.subagent,
            event: {
              targetSessionKey: sessionKey,
              runId: successorRunId,
              outcome: successorState.outcome,
              error: successorState.error,
            },
          });
          if (settlement.status === "retry-exhausted") {
            requestContinuation("durable");
          } else if (
            params.worktrees &&
            (settlement.status === "settled" || settlement.status === "already-terminal")
          ) {
            await cleanupWorkboardRunWorktree({
              store: params.store,
              worktrees: params.worktrees,
              runId: successorRunId,
              sessionKey,
            });
          }
          continue;
        }
        // A successor asserted by core but not positively found is not safe to
        // replace locally. Keep polling the exact generation fail-closed.
        requestContinuation("durable");
        continue;
      }

      // Only explicit core exhaustion transfers ownership to Workboard's
      // local retry budget.
      if (ownership.status !== "exhausted") {
        requestContinuation("durable");
        continue;
      }

      if (automation.maxRetries <= failureCount) {
        const settlement = await settleTerminatedWorkboardRun({
          store: params.store,
          subagent: params.subagent,
          event: {
            targetSessionKey: sessionKey,
            runId,
            outcome: "error",
            error: "Core restart recovery and the Workboard retry budget are exhausted.",
          },
        });
        if (settlement.status === "retry-exhausted") {
          requestContinuation("durable");
        } else if (
          params.worktrees &&
          (settlement.status === "settled" || settlement.status === "already-terminal")
        ) {
          await cleanupWorkboardRunWorktree({
            store: params.store,
            worktrees: params.worktrees,
            runId,
            sessionKey,
          });
        }
        continue;
      }

      const latest = await params.store.get(card.id);
      const latestRunId = latest?.runId ?? latest?.execution?.runId;
      if (
        latest?.status !== "running" ||
        latest.execution?.status !== "running" ||
        latestRunId !== runId
      ) {
        continue;
      }
      const latestRevision = latest.events?.at(-1)?.id;
      if (!latestRevision) {
        continue;
      }
      recoverable.push({ card: latest, runId, revision: latestRevision });
    } catch (error) {
      failures.push({
        cardId: card.id,
        title: card.title,
        error: formatErrorMessage(error),
      });
      requestContinuation("durable");
    }
  }

  const recoverableIds = new Set(recoverable.map(({ card }) => card.id));
  const recoveryCandidates = recoverable.map(({ card }) => ({
    ...card,
    status: "ready" as const,
    metadata: { ...card.metadata, claim: undefined },
  }));
  const selectedIds = new Set(
    selectStartableCards(
      cards,
      DEFAULT_DISPATCH_MAX_STARTS,
      recoveryCandidates,
      recoverableIds,
    ).map((card) => card.id),
  );
  const hasOverflow = recoverable.length > selectedIds.size;
  if (hasOverflow) {
    requestContinuation("bounded");
  }

  for (const candidate of recoverable) {
    if (!selectedIds.has(candidate.card.id)) {
      continue;
    }
    try {
      if (
        candidate.card.status === "ready" &&
        candidate.card.execution?.status === "idle" &&
        candidate.card.metadata?.automation?.recoveryRunId === candidate.runId
      ) {
        const latest = await params.store.get(candidate.card.id);
        if (
          latest?.events?.at(-1)?.id === candidate.revision &&
          latest.status === "ready" &&
          latest.execution?.status === "idle" &&
          latest.metadata?.automation?.recoveryRunId === candidate.runId
        ) {
          reconciled.push(latest.id);
        }
        continue;
      }
      const reclaimed = await params.store.recoverInterrupted(candidate.card.id, {
        expectedRunId: candidate.runId,
        expectedRevision: candidate.revision,
        reason: "Recovered an infrastructure-interrupted worker during Gateway startup.",
      });
      if (!reclaimed) {
        continue;
      }
      reconciled.push(reclaimed.id);
    } catch (error) {
      failures.push({
        cardId: candidate.card.id,
        title: candidate.card.title,
        error: formatErrorMessage(error),
      });
    }
  }

  if (reconciled.length === 0) {
    return {
      reconciled,
      started,
      failures,
      needsContinuation: Boolean(continuationMode),
      ...(continuationMode ? { continuationMode } : {}),
    };
  }
  const dispatch = await dispatchAndStartWorkboardCards({
    store: params.store,
    subagent: params.subagent,
    managedFlows: params.managedFlows,
    worktrees: params.worktrees,
    options: {
      now: params.options?.now,
      maxStarts: Math.min(DEFAULT_DISPATCH_MAX_STARTS, reconciled.length),
      candidateCardIds: new Set(reconciled),
      ignoredOwnerSlotCardIds: recoverableIds,
      allowManagedWorktrees: params.options?.allowManagedWorktrees,
      recoveryMode: true,
    },
  });
  const pendingRecoveryRemains = (await params.store.list()).some(
    (card) =>
      card.status === "ready" &&
      card.execution?.status === "idle" &&
      Boolean(card.metadata?.automation?.recoveryRunId),
  );
  if (pendingRecoveryRemains) {
    requestContinuation("bounded");
  }
  const pendingWorkerStartRemains = (await params.store.list()).some(
    (card) =>
      Boolean(card.metadata?.claim) &&
      Boolean(card.metadata?.automation?.startIdempotencyKey) &&
      Boolean(card.metadata?.automation?.startSessionKey),
  );
  if (pendingWorkerStartRemains) {
    requestContinuation(dispatch.needsReconciliation ? "durable" : "bounded");
  }
  return {
    reconciled,
    started: [...started, ...dispatch.started],
    failures: [...failures, ...dispatch.startFailures],
    needsContinuation: Boolean(continuationMode),
    ...(continuationMode ? { continuationMode } : {}),
  };
}

export async function cleanupWorkboardRunWorktree(params: {
  store: WorkboardStore;
  worktrees: WorkboardWorktreeRuntime;
  runId?: string;
  sessionKey?: string;
}): Promise<boolean> {
  const cards = await params.store.list();
  const card = params.runId
    ? cards.find((entry) => (entry.runId ?? entry.execution?.runId) === params.runId)
    : params.sessionKey
      ? cards.find(
          (entry) => (entry.sessionKey ?? entry.execution?.sessionKey) === params.sessionKey,
        )
      : undefined;
  const workspace = card?.metadata?.automation?.workspace;
  if (workspace?.kind !== "worktree" || !workspace.path) {
    return true;
  }
  return await params.worktrees.removeIfLossless({ path: workspace.path });
}
