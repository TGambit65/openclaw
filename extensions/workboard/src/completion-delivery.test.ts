import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completeWorkboardCardWithDelivery,
  reconcileWorkboardCompletionDeliveries,
  type WorkboardCompletionDeliveryRuntime,
  type WorkboardCompletionTaskFlowRuntime,
  type WorkboardVerifiedCompletionIntent,
} from "./completion-delivery.js";
import { WorkboardStore, type PersistedWorkboardCard, type WorkboardKeyedStore } from "./store.js";

function createMemoryStore(): WorkboardKeyedStore {
  const entries = new Map<string, PersistedWorkboardCard>();
  return {
    async register(key, value) {
      entries.set(key, structuredClone(value));
    },
    async lookup(key) {
      const value = entries.get(key);
      return value ? structuredClone(value) : undefined;
    },
    async delete(key) {
      return entries.delete(key);
    },
    async entries() {
      return [...entries].map(([key, value]) => ({ key, value: structuredClone(value) }));
    },
    async compareAndSwap(key, value, options) {
      if (entries.get(key)?.card.events?.at(-1)?.id !== options.expectedRevision) {
        return "stale";
      }
      entries.set(key, structuredClone(value));
      return "updated";
    },
  };
}

type RuntimeState = Awaited<ReturnType<WorkboardCompletionDeliveryRuntime["getRunState"]>>;
type ArmParams = Parameters<WorkboardCompletionDeliveryRuntime["requireCompletionDelivery"]>[0];
type ManagedFlowRecord = NonNullable<
  ReturnType<ReturnType<WorkboardCompletionTaskFlowRuntime["bindSession"]>["get"]>
>;

function makeRuntime(initialState: RuntimeState) {
  let state = initialState;
  const persistArm = async (params: ArmParams) => {
    const {
      sessionKey,
      idempotencyKey,
      expectedRevision: _revision,
      flowRevision: _flow,
      ...payload
    } = params;
    const intent: WorkboardVerifiedCompletionIntent = {
      kind: "verified_workboard_completion",
      ...payload,
      childSessionKey: sessionKey,
      obligationId: idempotencyKey,
      requesterSessionKey: "agent:main:telegram:direct:user-1",
      requesterOrigin: { channel: "telegram", to: "123", accountId: "default" },
      expectedRevision: params.expectedRevision,
      flowRevision: params.flowRevision,
      payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      acceptedAt: 10_000,
    };
    state = {
      ...state,
      deliveryStatus: state.deliveryStatus === "delivered" ? "delivered" : "pending",
      verifiedCompletionIntent: intent,
    };
    return {
      status: "armed" as const,
      deliveryStatus: state.deliveryStatus,
      verifiedCompletionIntent: intent,
    };
  };
  const requireCompletionDelivery =
    vi.fn<WorkboardCompletionDeliveryRuntime["requireCompletionDelivery"]>(persistArm);
  return {
    runtime: {
      requireCompletionDelivery,
      getRunState: vi.fn(async () => state),
    } satisfies WorkboardCompletionDeliveryRuntime,
    persistArm,
    requireCompletionDelivery,
    setState(next: RuntimeState) {
      state = next;
    },
    getState() {
      return state;
    },
  };
}

function makeTaskFlow(options: {
  cardId: string;
  revisionConflictOnce?: boolean;
  stateCardId?: string;
}) {
  let conflict = options.revisionConflictOnce === true;
  let flow: ManagedFlowRecord = {
    flowId: "flow-workboard-card",
    syncMode: "managed" as const,
    ownerKey: "agent:main:main",
    controllerId: "workboard",
    revision: 1,
    status: "running" as const,
    currentStep: "worker",
    stateJson: {
      schema: "openclaw.workboard.managed-flow.v1",
      controllerId: "workboard",
      cardId: options.stateCardId ?? options.cardId,
      workflowIdempotencyKey: "workflow:verified",
      phase: "waiting_worker",
    } as unknown,
    waitJson: undefined as unknown,
    cancelRequestedAt: undefined as number | undefined,
  };
  const mutation = (
    patch: Record<string, unknown>,
    expectedRevision: number,
    completionAcceptedAt?: number,
  ) => {
    if (conflict) {
      conflict = false;
      flow = { ...flow, revision: flow.revision + 1 };
      return { applied: false as const, code: "revision_conflict" as const, current: flow };
    }
    if (expectedRevision !== flow.revision) {
      return { applied: false as const, code: "revision_conflict" as const, current: flow };
    }
    if (
      completionAcceptedAt !== undefined &&
      flow.cancelRequestedAt !== undefined &&
      completionAcceptedAt > flow.cancelRequestedAt
    ) {
      return {
        applied: false as const,
        code: "completion_cancel_conflict" as const,
        current: flow,
      };
    }
    flow = {
      ...flow,
      ...patch,
      ...(completionAcceptedAt !== undefined ? { cancelRequestedAt: undefined } : {}),
      revision: flow.revision + 1,
    } as typeof flow;
    return { applied: true as const, flow };
  };
  const bound = {
    get: vi.fn((flowId: string) => (flowId === flow.flowId ? structuredClone(flow) : undefined)),
    getTaskSummary: vi.fn(() => ({ total: 2, succeeded: 1, running: 0 })),
    setWaiting: vi.fn((params: Record<string, unknown>) =>
      mutation(
        {
          status: "waiting",
          currentStep: params.currentStep,
          stateJson: params.stateJson,
          waitJson: params.waitJson,
        },
        params.expectedRevision as number,
        params.completionAcceptedAt as number | undefined,
      ),
    ),
    finish: vi.fn((params: Record<string, unknown>) =>
      mutation(
        { status: "succeeded", stateJson: params.stateJson, waitJson: undefined },
        params.expectedRevision as number,
        params.completionAcceptedAt as number | undefined,
      ),
    ),
    fail: vi.fn((params: Record<string, unknown>) =>
      mutation(
        { status: "failed", stateJson: params.stateJson, waitJson: undefined },
        params.expectedRevision as number,
        params.completionAcceptedAt as number | undefined,
      ),
    ),
  };
  const taskFlow = {
    bindSession: vi.fn(({ sessionKey }: { sessionKey: string }) => {
      expect(sessionKey).toBe("agent:main:main");
      return bound;
    }),
  } as unknown as WorkboardCompletionTaskFlowRuntime;
  return {
    taskFlow,
    bound,
    getFlow: () => structuredClone(flow),
    cancelAt(cancelRequestedAt: number) {
      flow = {
        ...flow,
        status: "cancelled",
        cancelRequestedAt,
        revision: flow.revision + 1,
      } as typeof flow;
    },
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createArtifact(content = "verified artifact\n") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-delivery-"));
  tempDirs.push(dir);
  const artifactPath = path.join(dir, "result.txt");
  fs.writeFileSync(artifactPath, content, "utf8");
  return { artifactPath, content };
}

function createDeliveryStore() {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-durable-"));
  tempDirs.push(artifactRoot);
  return new WorkboardStore(createMemoryStore(), { artifactRoot });
}

async function createClaimedAutomatedCard(params: {
  store: WorkboardStore;
  runId?: string;
  sessionKey?: string;
  pendingStart?: boolean;
}) {
  const runId = params.runId ?? "run-current";
  const sessionKey = params.sessionKey ?? "agent:main:subagent:workboard-card";
  const card = await params.store.create({
    title: "Verified work",
    status: params.pendingStart ? "ready" : "running",
    idempotencyKey: "workflow:verified",
    requesterSessionKey: "agent:main:telegram:direct:user-1",
    requesterOrigin: { channel: "telegram", to: "123", accountId: "default" },
    requesterWorkspace: os.tmpdir(),
    maxRetries: 2,
    ...(params.pendingStart
      ? {}
      : {
          sessionKey,
          runId,
          execution: {
            id: `execution:${runId}`,
            kind: "agent-session" as const,
            engine: "codex" as const,
            mode: "autonomous" as const,
            status: "running" as const,
            model: "default",
            sessionKey,
            runId,
            startedAt: 1,
            updatedAt: 1,
          },
        }),
  });
  await params.store.update(card.id, {
    metadata: {
      ...card.metadata,
      automation: {
        ...card.metadata?.automation,
        flowId: "flow-workboard-card",
        flowOwnerSessionKey: "agent:main:main",
        flowRevision: 1,
        controllerId: "workboard",
      },
    },
  });
  if (params.pendingStart) {
    return await params.store.claimForDispatch(
      card.id,
      { ownerId: "worker", token: "claim-token" },
      {
        startIdempotencyKey: runId,
        startSessionKey: sessionKey,
        workflowIdempotencyKey: "workflow:verified",
        maxRetries: 2,
      },
    );
  }
  return await params.store.claim(card.id, { ownerId: "worker", token: "claim-token" });
}

function completionInput(artifactPath: string, summary = "Shipped the durable result.") {
  return {
    ownerId: "worker",
    token: "claim-token",
    summary,
    proof: { status: "passed", command: "pnpm test" },
    artifacts: [{ path: artifactPath, label: "test result" }],
  };
}

describe("Workboard native completion delivery", () => {
  it("sets TaskFlow waiting before card projection, then finishes and cleans once after delivered", async () => {
    const store = createDeliveryStore();
    const claimed = await createClaimedAutomatedCard({ store });
    const { artifactPath, content } = createArtifact();
    const core = makeRuntime({ status: "active", deliveryStatus: "not_required" });
    const flow = makeTaskFlow({ cardId: claimed.card.id, revisionConflictOnce: true });
    core.requireCompletionDelivery.mockImplementationOnce(async (params) => {
      expect((await store.get(claimed.card.id))?.status).toBe("running");
      expect(
        (await store.get(claimed.card.id))?.metadata?.automation?.completionDelivery,
      ).toBeUndefined();
      return await core.persistArm(params);
    });

    const pending = await completeWorkboardCardWithDelivery({
      store,
      subagent: core.runtime,
      taskFlow: flow.taskFlow,
      id: claimed.card.id,
      input: completionInput(artifactPath),
      scope: { ownerId: "worker", token: "claim-token" },
    });
    expect(flow.getFlow()).toMatchObject({
      status: "waiting",
      currentStep: "completion_delivery",
      waitJson: { reason: "awaiting_native_completion_delivery" },
    });
    expect(flow.bound.setWaiting).toHaveBeenCalledWith(
      expect.objectContaining({ blockedSummary: null }),
    );
    expect(pending).toMatchObject({
      status: "review",
      execution: { status: "review" },
      metadata: {
        automation: {
          completionDelivery: {
            status: "pending",
            sessionKey: "agent:main:subagent:workboard-card",
            runId: "run-current",
          },
        },
        proof: [expect.objectContaining({ status: "passed", command: "pnpm test" })],
        artifacts: [
          expect.objectContaining({
            path: expect.any(String),
            byteSize: Buffer.byteLength(content),
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          }),
        ],
      },
    });
    expect(JSON.stringify(core.requireCompletionDelivery.mock.calls[0]?.[0])).not.toContain(
      "claim-token",
    );
    expect(pending.metadata?.notifications).toBeUndefined();

    const durableArtifact = pending.metadata?.artifacts?.find(
      (artifact) => artifact.sha256 && artifact.path,
    );
    if (!durableArtifact?.path || !durableArtifact.sha256) {
      throw new Error("expected durable completion artifact identity");
    }
    expect(durableArtifact.path).not.toBe(fs.realpathSync(artifactPath));
    const cleanup = vi.fn(async () => {
      fs.rmSync(path.dirname(artifactPath), { recursive: true, force: true });
    });
    const reconciliation = {
      store,
      subagent: core.runtime,
      taskFlow: flow.taskFlow,
      onDelivered: cleanup,
    };
    await reconcileWorkboardCompletionDeliveries(reconciliation);
    expect(cleanup).not.toHaveBeenCalled();
    core.setState({
      status: "terminal",
      outcome: "error",
      error: "worker crashed after workboard_complete",
      deliveryStatus: "delivered",
      deliveredAt: 12_000,
      verifiedCompletionIntent: core.getState().verifiedCompletionIntent,
    });
    await reconcileWorkboardCompletionDeliveries(reconciliation);
    expect(flow.getFlow()).toMatchObject({ status: "succeeded" });
    await expect(store.get(claimed.card.id)).resolves.toMatchObject({
      status: "done",
      metadata: {
        automation: {
          completionDelivery: {
            status: "delivered",
            deliveredAt: 12_000,
            cleanupCompletedAt: expect.any(Number),
          },
        },
        notifications: [expect.objectContaining({ kind: "completed" })],
      },
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(durableArtifact.path, "utf8")).toBe(content);
    expect(createHash("sha256").update(fs.readFileSync(durableArtifact.path)).digest("hex")).toBe(
      durableArtifact.sha256,
    );
    await reconcileWorkboardCompletionDeliveries(reconciliation);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("lets an armed completion beat later flow cancellation and clears the sticky cancel", async () => {
    const store = createDeliveryStore();
    const claimed = await createClaimedAutomatedCard({ store });
    const { artifactPath } = createArtifact("completion beats later cancellation\n");
    const core = makeRuntime({ status: "active", deliveryStatus: "not_required" });
    const flow = makeTaskFlow({ cardId: claimed.card.id });
    const pending = await completeWorkboardCardWithDelivery({
      store,
      subagent: core.runtime,
      taskFlow: flow.taskFlow,
      id: claimed.card.id,
      input: completionInput(artifactPath),
      scope: { ownerId: "worker", token: "claim-token" },
    });
    expect(pending).toMatchObject({
      status: "review",
      metadata: { automation: { completionDelivery: { status: "pending" } } },
    });
    expect(core.getState().verifiedCompletionIntent?.acceptedAt).toBe(10_000);

    const cleanup = vi.fn(async () => {});
    const reconciliation = {
      store,
      subagent: core.runtime,
      taskFlow: flow.taskFlow,
      onDelivered: cleanup,
    };
    flow.cancelAt(11_000);
    expect(flow.getFlow()).toMatchObject({ status: "cancelled", cancelRequestedAt: 11_000 });
    await reconcileWorkboardCompletionDeliveries(reconciliation);
    expect(flow.getFlow()).toMatchObject({ status: "waiting" });
    expect(flow.getFlow().cancelRequestedAt).toBeUndefined();
    expect(cleanup).not.toHaveBeenCalled();

    // Exercise the terminal race too: cancellation lands again after the
    // pending projection but before native delivery acknowledgement arrives.
    flow.cancelAt(11_500);
    core.setState({
      status: "terminal",
      outcome: "ok",
      deliveryStatus: "delivered",
      deliveredAt: 12_000,
      verifiedCompletionIntent: core.getState().verifiedCompletionIntent,
    });
    await reconcileWorkboardCompletionDeliveries(reconciliation);
    expect(flow.getFlow()).toMatchObject({ status: "succeeded" });
    expect(flow.getFlow().cancelRequestedAt).toBeUndefined();
    await expect(store.get(claimed.card.id)).resolves.toMatchObject({
      status: "done",
      metadata: {
        automation: {
          completionDelivery: {
            status: "delivered",
            cleanupCompletedAt: expect.any(Number),
          },
        },
      },
    });
    expect(core.requireCompletionDelivery).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await reconcileWorkboardCompletionDeliveries(reconciliation);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("keeps a pre-arm cancelled flow authoritative when core rejects completion", async () => {
    const store = createDeliveryStore();
    const claimed = await createClaimedAutomatedCard({ store });
    const { artifactPath } = createArtifact("cancel wins before arm\n");
    const core = makeRuntime({ status: "active", deliveryStatus: "not_required" });
    const flow = makeTaskFlow({ cardId: claimed.card.id });
    flow.cancelAt(9_000);
    core.requireCompletionDelivery.mockResolvedValueOnce({
      status: "unknown",
      error: "verified completion flow linkage is unavailable",
    });

    await expect(
      completeWorkboardCardWithDelivery({
        store,
        subagent: core.runtime,
        taskFlow: flow.taskFlow,
        id: claimed.card.id,
        input: completionInput(artifactPath),
        scope: { ownerId: "worker", token: "claim-token" },
      }),
    ).rejects.toThrow("core did not persist the verified Workboard completion intent");
    expect(flow.getFlow()).toMatchObject({ status: "cancelled", cancelRequestedAt: 9_000 });
    expect(core.getState().verifiedCompletionIntent).toBeUndefined();
    await expect(store.get(claimed.card.id)).resolves.toMatchObject({
      status: "running",
      metadata: { claim: { ownerId: "worker" } },
    });
  });

  it("restores the exact structured core intent after arm-to-card-CAS crash", async () => {
    const store = createDeliveryStore();
    const claimed = await createClaimedAutomatedCard({ store });
    const { artifactPath } = createArtifact("crash boundary\n");
    const core = makeRuntime({ status: "active", deliveryStatus: "not_required" });
    const flow = makeTaskFlow({ cardId: claimed.card.id });
    const originalCommit = store.commitVerifiedCompletionIntent.bind(store);
    vi.spyOn(store, "commitVerifiedCompletionIntent")
      .mockRejectedValueOnce(new Error("forced crash after native arm and flow wait"))
      .mockImplementation(originalCommit);

    await expect(
      completeWorkboardCardWithDelivery({
        store,
        subagent: core.runtime,
        taskFlow: flow.taskFlow,
        id: claimed.card.id,
        input: completionInput(artifactPath, "Exact crash-safe summary."),
        scope: { ownerId: "worker", token: "claim-token" },
      }),
    ).rejects.toThrow("forced crash");
    expect(flow.getFlow().status).toBe("waiting");
    expect((await store.get(claimed.card.id))?.status).toBe("running");

    await reconcileWorkboardCompletionDeliveries({
      store,
      subagent: core.runtime,
      taskFlow: flow.taskFlow,
    });
    const mirrored = await store.get(claimed.card.id);
    expect(mirrored).toMatchObject({
      status: "review",
      metadata: {
        proof: [expect.objectContaining({ status: "passed", command: "pnpm test" })],
        artifacts: [
          expect.objectContaining({
            path: expect.any(String),
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            verifiedAt: expect.any(Number),
          }),
        ],
        automation: {
          summary: "Exact crash-safe summary.",
          completionDelivery: {
            payloadHash: core.getState().verifiedCompletionIntent?.payloadHash,
          },
        },
      },
    });
    expect(JSON.stringify(mirrored)).not.toContain("claim-token");
  });

  it("keeps retrying without reconstructing a missing core obligation from the card", async () => {
    vi.useFakeTimers();
    const store = createDeliveryStore();
    const claimed = await createClaimedAutomatedCard({ store });
    const { artifactPath } = createArtifact("restore gap\n");
    const core = makeRuntime({ status: "active", deliveryStatus: "not_required" });
    const flow = makeTaskFlow({ cardId: claimed.card.id });
    await completeWorkboardCardWithDelivery({
      store,
      subagent: core.runtime,
      taskFlow: flow.taskFlow,
      id: claimed.card.id,
      input: completionInput(artifactPath),
      scope: { ownerId: "worker", token: "claim-token" },
    });
    core.setState({ status: "unknown", deliveryStatus: "pending" });
    core.requireCompletionDelivery.mockResolvedValueOnce({ status: "unknown" });
    const warnings: unknown[] = [];
    const result = await reconcileWorkboardCompletionDeliveries({
      store,
      subagent: core.runtime,
      taskFlow: flow.taskFlow,
      logger: { warn: (...args) => warnings.push(args) },
    });

    expect(core.requireCompletionDelivery).toHaveBeenCalledTimes(1);
    expect(result.needsContinuation).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(warnings).toEqual([
      expect.arrayContaining([
        "workboard completion delivery reconciliation failed",
        expect.objectContaining({ cardId: claimed.card.id }),
      ]),
    ]);
    await expect(store.get(claimed.card.id)).resolves.toMatchObject({
      status: "review",
      metadata: { automation: { completionDelivery: { status: "pending" } } },
    });
  });

  it("reuses an accepted arm after response loss and benign heartbeat, but rejects conflict", async () => {
    const store = createDeliveryStore();
    const claimed = await createClaimedAutomatedCard({
      store,
      runId: "run-r2-success",
      sessionKey: "agent:main:subagent:restart-chain",
    });
    const { artifactPath } = createArtifact("successor\n");
    const core = makeRuntime({ status: "active", deliveryStatus: "not_required" });
    const flow = makeTaskFlow({ cardId: claimed.card.id });
    core.requireCompletionDelivery.mockImplementationOnce(async (params) => {
      await core.persistArm(params);
      throw new Error("arm response lost after durable accept");
    });
    const args = {
      store,
      subagent: core.runtime,
      taskFlow: flow.taskFlow,
      id: claimed.card.id,
      input: completionInput(artifactPath, "R2 produced the verified result."),
      scope: { ownerId: "worker", token: "claim-token" },
    };
    await expect(completeWorkboardCardWithDelivery(args)).rejects.toThrow("response lost");
    await expect(
      completeWorkboardCardWithDelivery({
        ...args,
        input: completionInput(artifactPath, "Conflicting replacement result."),
      }),
    ).rejects.toThrow("conflicts with the core-owned obligation");
    await store.heartbeat(claimed.card.id, { token: "claim-token", note: "still alive" });
    const pending = await completeWorkboardCardWithDelivery(args);
    expect(pending.status).toBe("review");
    expect(core.requireCompletionDelivery).toHaveBeenCalledTimes(1);
    expect(core.requireCompletionDelivery.mock.calls[0]?.[0].runId).toBe("run-r2-success");
  });

  it("refuses a core intent after a concurrent block changes claim generation", async () => {
    const store = createDeliveryStore();
    const claimed = await createClaimedAutomatedCard({ store });
    const { artifactPath } = createArtifact("blocked race\n");
    const core = makeRuntime({ status: "active", deliveryStatus: "not_required" });
    const flow = makeTaskFlow({ cardId: claimed.card.id });
    core.requireCompletionDelivery.mockImplementationOnce(async (params) => {
      await core.persistArm(params);
      throw new Error("arm response lost after durable accept");
    });
    await expect(
      completeWorkboardCardWithDelivery({
        store,
        subagent: core.runtime,
        taskFlow: flow.taskFlow,
        id: claimed.card.id,
        input: completionInput(artifactPath),
        scope: { ownerId: "worker", token: "claim-token" },
      }),
    ).rejects.toThrow("response lost");
    await store.block(claimed.card.id, {
      ownerId: "worker",
      token: "claim-token",
      reason: "Operator rejected completion.",
    });
    const warnings: unknown[] = [];
    await reconcileWorkboardCompletionDeliveries({
      store,
      subagent: core.runtime,
      taskFlow: flow.taskFlow,
      logger: { warn: (...args) => warnings.push(args) },
    });
    expect((await store.get(claimed.card.id))?.status).toBe("blocked");
    expect(
      (await store.get(claimed.card.id))?.metadata?.automation?.completionDelivery,
    ).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it("refuses to mutate a stale managed flow whose durable card identity is different", async () => {
    const store = createDeliveryStore();
    const claimed = await createClaimedAutomatedCard({ store });
    const { artifactPath } = createArtifact("stale flow\n");
    const core = makeRuntime({ status: "active", deliveryStatus: "not_required" });
    const flow = makeTaskFlow({
      cardId: claimed.card.id,
      stateCardId: "different-card-generation",
    });

    await expect(
      completeWorkboardCardWithDelivery({
        store,
        subagent: core.runtime,
        taskFlow: flow.taskFlow,
        id: claimed.card.id,
        input: completionInput(artifactPath),
        scope: { ownerId: "worker", token: "claim-token" },
      }),
    ).rejects.toThrow("stale or corrupt managed TaskFlow state");
    expect(flow.bound.setWaiting).not.toHaveBeenCalled();
    const unchanged = await store.get(claimed.card.id);
    expect(unchanged?.status).toBe("running");
    expect(unchanged?.metadata?.automation?.completionDelivery).toBeUndefined();
  });

  it("uses durable pending-start identity when completion beats recordStartedWorker", async () => {
    const store = createDeliveryStore();
    const claimed = await createClaimedAutomatedCard({
      store,
      pendingStart: true,
      runId: "run-fast-start",
      sessionKey: "agent:main:subagent:fast-start",
    });
    const { artifactPath } = createArtifact("fast\n");
    const core = makeRuntime({ status: "active", deliveryStatus: "not_required" });
    const flow = makeTaskFlow({ cardId: claimed.card.id });
    await completeWorkboardCardWithDelivery({
      store,
      subagent: core.runtime,
      taskFlow: flow.taskFlow,
      id: claimed.card.id,
      input: completionInput(artifactPath, "Completed before run mapping."),
      scope: { ownerId: "worker", token: "claim-token" },
    });
    expect(core.requireCompletionDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:subagent:fast-start",
        runId: "run-fast-start",
        expectedRunId: "run-fast-start",
      }),
    );
  });

  it("re-arms suspended delivery while keeping the card and managed flow waiting", async () => {
    const store = createDeliveryStore();
    const claimed = await createClaimedAutomatedCard({ store });
    const { artifactPath } = createArtifact("suspended\n");
    const core = makeRuntime({ status: "active", deliveryStatus: "not_required" });
    const flow = makeTaskFlow({ cardId: claimed.card.id });
    await completeWorkboardCardWithDelivery({
      store,
      subagent: core.runtime,
      taskFlow: flow.taskFlow,
      id: claimed.card.id,
      input: completionInput(artifactPath, "Retry this exact delivery."),
      scope: { ownerId: "worker", token: "claim-token" },
    });
    core.setState({
      status: "terminal",
      outcome: "ok",
      deliveryStatus: "suspended",
      deliveryError: "bounded announce retry paused",
      verifiedCompletionIntent: core.getState().verifiedCompletionIntent,
    });
    await reconcileWorkboardCompletionDeliveries({
      store,
      subagent: core.runtime,
      taskFlow: flow.taskFlow,
    });

    expect(core.requireCompletionDelivery).toHaveBeenCalledTimes(2);
    expect(core.requireCompletionDelivery.mock.calls[1]?.[0]).toMatchObject({
      idempotencyKey: core.getState().verifiedCompletionIntent?.obligationId,
      summary: "Retry this exact delivery.",
    });
    expect(flow.getFlow()).toMatchObject({ status: "waiting" });
    await expect(store.get(claimed.card.id)).resolves.toMatchObject({
      status: "review",
      metadata: { automation: { completionDelivery: { status: "pending" } } },
    });
  });

  it.each(["failed", "discarded"] as const)(
    "blocks terminal %s delivery idempotently without reporting done",
    async (deliveryStatus) => {
      const store = createDeliveryStore();
      const claimed = await createClaimedAutomatedCard({ store });
      const { artifactPath } = createArtifact(`${deliveryStatus}\n`);
      const core = makeRuntime({ status: "active", deliveryStatus: "not_required" });
      const flow = makeTaskFlow({ cardId: claimed.card.id });
      await completeWorkboardCardWithDelivery({
        store,
        subagent: core.runtime,
        taskFlow: flow.taskFlow,
        id: claimed.card.id,
        input: completionInput(artifactPath, "Verified but not delivered."),
        scope: { ownerId: "worker", token: "claim-token" },
      });
      core.setState({
        status: "terminal",
        outcome: "ok",
        deliveryStatus,
        deliveryError: "requester handoff failed",
        discardReason: deliveryStatus === "discarded" ? "expired" : undefined,
        verifiedCompletionIntent: core.getState().verifiedCompletionIntent,
      });
      const reconciliation = {
        store,
        subagent: core.runtime,
        taskFlow: flow.taskFlow,
      };
      await reconcileWorkboardCompletionDeliveries(reconciliation);
      const once = await store.get(claimed.card.id);
      const eventCount = once?.events?.length;
      const failureCount = once?.metadata?.failureCount;
      expect(once).toMatchObject({
        status: "blocked",
        metadata: {
          automation: { completionDelivery: { status: deliveryStatus } },
          attempts: [expect.objectContaining({ status: "blocked" })],
          diagnostics: [
            expect.objectContaining({
              kind: "completion_delivery_failed",
              severity: "critical",
            }),
          ],
        },
      });
      await reconcileWorkboardCompletionDeliveries(reconciliation);
      const replay = await store.get(claimed.card.id);
      expect(replay?.events).toHaveLength(eventCount ?? 0);
      expect(replay?.metadata?.failureCount).toBe(failureCount);
      expect(replay?.metadata?.notifications?.some((entry) => entry.kind === "completed")).toBe(
        false,
      );
    },
  );
});
