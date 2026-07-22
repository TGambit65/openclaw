// Workboard tests cover dispatcher plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupWorkboardRunWorktree,
  dispatchAndStartWorkboardCards,
  reconcileInterruptedWorkboardCards,
  settleTerminatedWorkboardRun,
} from "./dispatcher.js";
import { createWorkboardRecoveryController } from "./recovery-controller.js";
import { WorkboardStore, type PersistedWorkboardCard, type WorkboardKeyedStore } from "./store.js";

function createMemoryStore<T = PersistedWorkboardCard>(): WorkboardKeyedStore<T> {
  const entries = new Map<string, T>();
  return {
    async register(key, value) {
      entries.set(key, value);
    },
    async lookup(key) {
      return entries.get(key);
    },
    async delete(key) {
      return entries.delete(key);
    },
    async entries() {
      return [...entries].flatMap(([key, value]) => (value ? [{ key, value }] : []));
    },
  };
}

type TestRunParams = {
  sessionKey: string;
  message: string;
  idempotencyKey?: string;
};

function createEchoRun() {
  return vi.fn(async (params: TestRunParams) => ({
    runId: params.idempotencyKey ?? `unexpected-run-${params.sessionKey}`,
  }));
}

function unknownRecoveryRuntime(run = createEchoRun()) {
  return {
    run,
    waitForRun: vi.fn().mockResolvedValue({ status: "timeout" as const }),
    getRecoveryOwnership: vi.fn().mockResolvedValue({ status: "unknown" as const }),
    getRunState: vi.fn().mockResolvedValue({ status: "unknown" as const }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("dispatchAndStartWorkboardCards", () => {
  it("starts a card inside one managed TaskFlow and waits on the exact child run", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Managed workflow worker",
      status: "ready",
      idempotencyKey: "managed-workflow-card",
      agentId: "codex-main",
    });
    const flow = {
      flowId: "flow-managed-workflow-card",
      syncMode: "managed" as const,
      ownerKey: "agent:codex-main:telegram:direct:requester",
      requesterOrigin: { channel: "telegram", to: "requester" },
      controllerId: "workboard",
      revision: 1,
      status: "running" as const,
      notifyPolicy: "silent" as const,
      goal: "Managed workflow worker",
      currentStep: "starting",
      stateJson: {
        schema: "openclaw.workboard.managed-flow.v1",
        controllerId: "workboard",
        cardId: card.id,
        workflowIdempotencyKey: "managed-workflow-card",
      },
      createdAt: 10,
      updatedAt: 10,
    };
    const createManaged = vi.fn(() => flow);
    const setWaiting = vi.fn(() => ({
      applied: true as const,
      flow: { ...flow, revision: 2, status: "waiting" as const, currentStep: "worker" },
    }));
    const bindSession = vi.fn(() => ({
      sessionKey: flow.ownerKey,
      createManaged,
      tryCreateManaged: vi.fn(),
      get: vi.fn((flowId: string) => (flowId === flow.flowId ? flow : undefined)),
      list: vi.fn(() => []),
      findLatest: vi.fn(),
      resolve: vi.fn(),
      getTaskSummary: vi.fn(),
      setWaiting,
      resume: vi.fn(),
      finish: vi.fn(),
      fail: vi.fn(),
      requestCancel: vi.fn(),
      cancel: vi.fn(),
      runTask: vi.fn(),
    }));
    const run = createEchoRun();

    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run } as never,
      managedFlows: { bindSession } as never,
      options: {
        now: 10,
        maxStarts: 1,
        requesterSessionKey: "agent:codex-main:telegram:direct:requester",
        requesterOrigin: { channel: "telegram", to: "requester" },
        requesterWorkspace: "/workspace/requester",
      },
    } as never);

    expect(bindSession).toHaveBeenCalledWith({
      sessionKey: flow.ownerKey,
      requesterOrigin: { channel: "telegram", to: "requester" },
    });
    expect(createManaged).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/workspace/requester",
        parentFlowId: flow.flowId,
        flowOwnerSessionKey: flow.ownerKey,
      }),
    );
    expect(setWaiting).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: flow.flowId,
        expectedRevision: 1,
        currentStep: "worker",
        blockedSummary: expect.stringContaining(run.mock.calls[0]?.[0].idempotencyKey ?? ""),
      }),
    );
    await expect(store.get(card.id)).resolves.toMatchObject({
      metadata: {
        automation: {
          flowId: flow.flowId,
          flowOwnerSessionKey: flow.ownerKey,
          flowRevision: 2,
          controllerId: "workboard",
        },
      },
    });
  });

  it("recovers a crash after the card block by failing and detaching its managed flow", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Managed block crash window",
      status: "ready",
      idempotencyKey: "managed-block-crash-window",
      agentId: "main",
    });
    const ownerSessionKey = "agent:main:telegram:direct:requester";
    let currentFlow: Record<string, unknown> | undefined;
    const bound = {
      sessionKey: ownerSessionKey,
      createManaged: vi.fn((input: Record<string, unknown>) => {
        currentFlow = {
          ...input,
          flowId: "flow-managed-block-crash-window",
          syncMode: "managed",
          ownerKey: ownerSessionKey,
          revision: 1,
        };
        return currentFlow;
      }),
      list: vi.fn(() => (currentFlow ? [currentFlow] : [])),
      get: vi.fn(() => currentFlow),
      setWaiting: vi.fn((input: Record<string, unknown>) => {
        currentFlow = {
          ...currentFlow,
          status: "waiting",
          revision: Number(currentFlow?.revision) + 1,
          stateJson: input.stateJson,
          waitJson: input.waitJson,
        };
        return { applied: true, flow: currentFlow };
      }),
      fail: vi.fn((input: Record<string, unknown>) => {
        currentFlow = {
          ...currentFlow,
          status: "failed",
          revision: Number(currentFlow?.revision) + 1,
          stateJson: input.stateJson,
          blockedSummary: input.blockedSummary,
          endedAt: input.endedAt,
        };
        return { applied: true, flow: currentFlow };
      }),
    };
    const managedFlows = { bindSession: vi.fn(() => bound) };
    const run = createEchoRun();
    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run } as never,
      managedFlows: managedFlows as never,
      options: {
        now: 10,
        maxStarts: 1,
        requesterSessionKey: ownerSessionKey,
        requesterWorkspace: "/workspace/requester",
      },
    });
    const running = await store.get(card.id);
    const claim = running?.metadata?.claim;
    if (!claim) {
      throw new Error("expected managed worker claim");
    }

    await store.block(
      card.id,
      { reason: "Needs operator input." },
      { ownerId: claim.ownerId, token: claim.token },
    );
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "blocked",
      metadata: { automation: { flowId: "flow-managed-block-crash-window" } },
    });

    const recovered = await reconcileInterruptedWorkboardCards({
      store,
      subagent: unknownRecoveryRuntime(run),
      managedFlows: managedFlows as never,
      sessions: { getSessionEntry: vi.fn() },
      options: { now: 20 },
    });

    expect(recovered.reconciled).toContain(card.id);
    expect(recovered.needsContinuation).toBe(false);
    expect(currentFlow).toMatchObject({
      status: "failed",
      blockedSummary: "Needs operator input.",
      stateJson: expect.objectContaining({ phase: "failed", runId: running?.runId }),
    });
    const blocked = await store.get(card.id);
    expect(blocked?.metadata?.automation).not.toHaveProperty("flowId");
    expect(blocked?.metadata?.automation).not.toHaveProperty("controllerId");
  });

  it("fails closed instead of guessing a global owner when the initiating session is absent", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Canonical default worker",
      status: "ready",
      idempotencyKey: "canonical-default-worker",
    });
    const bindSession = vi.fn();
    const run = createEchoRun();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run } as never,
      managedFlows: { bindSession } as never,
      options: { now: 10, maxStarts: 1 },
    } as never);

    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: expect.stringContaining("exact initiating requester session"),
      }),
    ]);
    expect(bindSession).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("resumes the same waiting managed TaskFlow before starting a retry generation", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const created = await store.create({
      title: "Managed retry worker",
      status: "ready",
      idempotencyKey: "managed-retry-card",
      agentId: "codex-main",
    });
    const flow = {
      flowId: "flow-managed-retry-card",
      syncMode: "managed" as const,
      ownerKey: "agent:codex-main:main",
      controllerId: "workboard",
      revision: 5,
      status: "waiting" as const,
      notifyPolicy: "silent" as const,
      goal: "Managed retry worker",
      currentStep: "worker",
      stateJson: {
        schema: "openclaw.workboard.managed-flow.v1",
        controllerId: "workboard",
        cardId: created.id,
        workflowIdempotencyKey: "managed-retry-card",
        phase: "waiting_worker",
        runId: "run-r1",
      },
      waitJson: { kind: "workboard_worker", cardId: created.id, runId: "run-r1" },
      createdAt: 1,
      updatedAt: 5,
    };
    const card = await store.update(created.id, {
      metadata: {
        ...created.metadata,
        automation: {
          ...created.metadata?.automation,
          flowId: flow.flowId,
          flowOwnerSessionKey: flow.ownerKey,
          flowRevision: flow.revision,
          controllerId: "workboard",
        },
      },
    });
    let currentFlow: Omit<typeof flow, "status" | "revision"> & {
      status: "waiting" | "running";
      revision: number;
    } = flow;
    const resume = vi.fn(() => {
      currentFlow = {
        ...currentFlow,
        status: "running",
        revision: 6,
        currentStep: "starting",
      };
      return { applied: true as const, flow: currentFlow };
    });
    const setWaiting = vi.fn(() => {
      currentFlow = {
        ...currentFlow,
        status: "waiting",
        revision: 7,
        currentStep: "worker",
      };
      return { applied: true as const, flow: currentFlow };
    });
    const bindSession = vi.fn(() => ({
      sessionKey: flow.ownerKey,
      createManaged: vi.fn(),
      tryCreateManaged: vi.fn(),
      get: vi.fn(() => currentFlow),
      list: vi.fn(() => [currentFlow]),
      findLatest: vi.fn(),
      resolve: vi.fn(),
      getTaskSummary: vi.fn(),
      setWaiting,
      resume,
      finish: vi.fn(),
      fail: vi.fn(),
      requestCancel: vi.fn(),
      cancel: vi.fn(),
      runTask: vi.fn(),
    }));
    const run = createEchoRun();

    await dispatchAndStartWorkboardCards({
      store,
      subagent: {
        run,
        resolveOwnerSession: vi.fn().mockResolvedValue({
          status: "resolved" as const,
          workerSessionKey: `agent:codex-main:subagent:workboard-default-${card.id}`,
          ownerSessionKey: flow.ownerKey,
          workspaceDir: "/tmp/canonical-worker-workspace",
        }),
      } as never,
      managedFlows: { bindSession } as never,
      options: { now: 10, maxStarts: 1 },
    } as never);

    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: flow.flowId,
        expectedRevision: 5,
        status: "running",
        currentStep: "starting",
      }),
    );
    expect(resume.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0] ?? 0);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        parentFlowId: flow.flowId,
        flowOwnerSessionKey: flow.ownerKey,
      }),
    );
    expect(setWaiting).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 6 }));
    await expect(store.get(card.id)).resolves.toMatchObject({
      metadata: { automation: { flowId: flow.flowId, flowRevision: 7 } },
    });
  });

  it("materializes managed worktrees, supplies cwd, persists them, and cleans up on run end", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Isolated worker",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo", branch: "main" },
    });
    const run = createEchoRun();
    const worktrees = {
      create: vi.fn().mockResolvedValue({
        id: "managed-id",
        path: "/state/worktrees/fingerprint/wb-card",
        branch: `openclaw/wb-${card.id}`,
      }),
      release: vi.fn(),
      removeIfLossless: vi.fn().mockResolvedValue(true),
    };

    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees,
      options: { now: 10, maxStarts: 1 },
    });

    expect(worktrees.create).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: "/repo",
        baseRef: "main",
        ownerKind: "workboard",
        ownerId: card.id,
      }),
    );
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/state/worktrees/fingerprint/wb-card" }),
    );
    await expect(store.get(card.id)).resolves.toMatchObject({
      metadata: {
        automation: {
          workspace: {
            kind: "worktree",
            path: "/state/worktrees/fingerprint/wb-card",
            branch: `openclaw/wb-${card.id}`,
            sourcePath: "/repo",
            sourceBranch: "main",
          },
        },
      },
    });

    await cleanupWorkboardRunWorktree({
      store,
      worktrees,
      runId: run.mock.calls[0]?.[0].idempotencyKey,
    });
    expect(worktrees.removeIfLossless).toHaveBeenCalledWith({
      path: "/state/worktrees/fingerprint/wb-card",
    });
  });

  it("does not clean up a successor worktree for a stale predecessor run", async () => {
    const store = new WorkboardStore(createMemoryStore());
    await store.create({
      title: "Restarted isolated worker",
      status: "running",
      sessionKey: "agent:main:subagent:managed-restart",
      runId: "run-before-managed-restart",
      workspace: {
        kind: "worktree",
        path: "/state/worktrees/fingerprint/wb-restarted",
        branch: "openclaw/wb-restarted",
        sourcePath: "/repo",
        sourceBranch: "main",
      },
    });
    const worktrees = {
      create: vi.fn(),
      release: vi.fn(),
      removeIfLossless: vi.fn().mockResolvedValue(true),
    };

    await cleanupWorkboardRunWorktree({
      store,
      worktrees,
      runId: "run-after-managed-restart",
      sessionKey: "agent:main:subagent:managed-restart",
    });

    expect(worktrees.removeIfLossless).not.toHaveBeenCalled();

    await cleanupWorkboardRunWorktree({
      store,
      worktrees,
      sessionKey: "agent:main:subagent:managed-restart",
    });
    expect(worktrees.removeIfLossless).toHaveBeenCalledWith({
      path: "/state/worktrees/fingerprint/wb-restarted",
    });
  });

  it("requires gateway admin authorization before materializing a worktree", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Protected checkout",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo" },
    });
    const worktrees = {
      create: vi.fn(),
      release: vi.fn(),
      removeIfLossless: vi.fn(),
    };

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn() },
      worktrees,
      options: { maxStarts: 1, allowManagedWorktrees: false },
    });

    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: "managed worktree dispatch requires operator.admin",
      }),
    ]);
    expect(worktrees.create).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("does not reuse a generated branch as an omitted source base", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Branchless retry",
      status: "ready",
      workspace: {
        kind: "worktree",
        path: "/state/worktrees/fingerprint/wb-card",
        branch: "openclaw/wb-card",
        sourcePath: "/repo",
      },
    });
    const create = vi.fn().mockResolvedValue({
      id: "managed-id",
      path: "/state/worktrees/fingerprint/wb-card",
      branch: "openclaw/wb-card",
    });

    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: createEchoRun() },
      worktrees: { create, release: vi.fn(), removeIfLossless: vi.fn() },
      options: { maxStarts: 1 },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: "/repo", ownerId: card.id }),
    );
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("baseRef");
  });

  it("claims ready cards and starts bounded subagent worker runs", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const first = await store.create({
      title: "First worker",
      status: "ready",
      priority: "urgent",
      agentId: "codex-main",
    });
    const second = await store.create({
      title: "Second worker",
      status: "ready",
      priority: "normal",
      agentId: "codex-main",
    });
    const otherAgent = await store.create({
      title: "Other worker",
      status: "ready",
      priority: "high",
      agentId: "codex-side",
    });
    const run = createEchoRun();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 3 },
    });

    expect(result.started.map((entry) => entry.cardId).toSorted()).toEqual(
      [first.id, otherAgent.id].toSorted(),
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: `agent:codex-main:subagent:workboard-default-${first.id}`,
      lane: `workboard:default:${first.id}`,
      deliver: false,
    });
    expect(run.mock.calls[0]?.[0]?.message).toContain("Claim token:");
    expect(run.mock.calls[0]?.[0]?.message).toContain("workboard_complete with the card id");
    expect(run.mock.calls[0]?.[0]?.message).not.toContain("ownerId and token");
    const firstRunId = run.mock.calls[0]?.[0].idempotencyKey;
    if (!firstRunId) {
      throw new Error("expected dispatcher to persist a start idempotency key");
    }
    await expect(store.get(first.id)).resolves.toMatchObject({
      status: "running",
      sessionKey: `agent:codex-main:subagent:workboard-default-${first.id}`,
      runId: firstRunId,
      execution: { status: "running", runId: firstRunId },
      metadata: {
        claim: { ownerId: "codex-main" },
        workerLogs: [expect.objectContaining({ message: expect.stringContaining(firstRunId) })],
      },
    });
    await expect(store.get(second.id)).resolves.toMatchObject({
      status: "ready",
      metadata: { automation: { dispatchCount: 1 } },
    });
  });

  it("does not let review cards consume an agent running slot", async () => {
    const store = new WorkboardStore(createMemoryStore());
    await store.create({
      title: "Waiting for operator review",
      status: "review",
      priority: "normal",
      agentId: "codex-main",
    });
    const ready = await store.create({
      title: "Next ready card",
      status: "ready",
      priority: "high",
      agentId: "codex-main",
    });
    const run = createEchoRun();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 3 },
    });

    expect(result.started).toEqual([
      expect.objectContaining({
        cardId: ready.id,
        runId: run.mock.calls[0]?.[0].idempotencyKey,
      }),
    ]);
    expect(run).toHaveBeenCalledOnce();
  });

  it("starts workers only for the selected board", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const ops = await store.create({
      title: "Ops worker",
      status: "ready",
      priority: "urgent",
      boardId: "ops",
    });
    const product = await store.create({
      title: "Product worker",
      status: "ready",
      priority: "urgent",
      boardId: "product",
    });
    const run = createEchoRun();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 3, boardId: "ops" },
    });

    expect(result.started).toEqual([expect.objectContaining({ cardId: ops.id })]);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: `subagent:workboard-ops-${ops.id}`,
      lane: `workboard:ops:${ops.id}`,
    });
    await expect(store.get(product.id)).resolves.toMatchObject({
      status: "ready",
      metadata: { automation: { boardId: "product" } },
    });
  });

  it("keeps claimed review cards in the owner running slot", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const review = await store.create({
      title: "Claimed operator review",
      status: "review",
      priority: "normal",
      agentId: "codex-main",
    });
    await store.claim(review.id, { ownerId: "codex-main", token: "review-token" });
    await store.create({
      title: "Next ready card",
      status: "ready",
      priority: "high",
      agentId: "codex-main",
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-next" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 3 },
    });

    expect(result.started).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("preserves a durable pending start when the run response is ambiguous", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Fail worker", status: "ready" });
    const run = vi.fn().mockRejectedValue(new Error("model unavailable"));

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 1 },
    });

    expect(result.started).toEqual([]);
    expect(result.startFailures).toEqual([
      expect.objectContaining({ cardId: card.id, error: "model unavailable" }),
    ]);
    expect(result.needsReconciliation).toBe(true);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: `subagent:workboard-default-${card.id}`,
      }),
    );
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      metadata: {
        claim: expect.objectContaining({ token: expect.any(String) }),
        automation: {
          startIdempotencyKey: expect.any(String),
          startSessionKey: `subagent:workboard-default-${card.id}`,
        },
      },
    });
  });

  it.each([
    { crashPoint: "after claim", preMaterialized: false },
    { crashPoint: "after worktree create", preMaterialized: true },
  ])(
    "idempotently materializes a managed worktree before pending-start recovery $crashPoint",
    async ({ preMaterialized }) => {
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({
        title: "Recovered isolated worker",
        status: "ready",
        agentId: "main",
        workspace: { kind: "worktree", path: "/repo", branch: "main" },
        requesterSessionKey: "agent:main:telegram:direct:requester",
        requesterOrigin: { channel: "telegram", to: "requester" },
      });
      const sessionKey = `agent:main:subagent:workboard-default-${card.id}`;
      const runId = `workboard:${card.id}:start:pending`;
      const claimed = await store.claimForDispatch(
        card.id,
        { ownerId: "main", ttlSeconds: 600 },
        {
          ownerSlotId: "main",
          startIdempotencyKey: runId,
          startSessionKey: sessionKey,
          startModel: "default",
          workflowIdempotencyKey: `workboard:${card.id}:workflow`,
          maxRetries: 2,
        },
      );
      const managedPath = "/state/worktrees/fingerprint/wb-recovered";
      if (preMaterialized) {
        await store.update(claimed.card.id, {
          workspace: {
            kind: "worktree",
            path: managedPath,
            branch: "openclaw/wb-recovered",
            sourcePath: "/repo",
            sourceBranch: "main",
          },
        });
      }
      const activeRuns = new Set<string>();
      const run = vi.fn(async (input: TestRunParams & { cwd?: string }) => {
        activeRuns.add(input.idempotencyKey!);
        return { runId: input.idempotencyKey! };
      });
      const create = vi.fn().mockResolvedValue({
        id: "managed-id",
        path: managedPath,
        branch: "openclaw/wb-recovered",
      });
      let flow: Record<string, unknown> | undefined;
      const bindSession = vi.fn(() => ({
        sessionKey: "agent:main:telegram:direct:requester",
        list: vi.fn(() => (flow ? [flow] : [])),
        get: vi.fn(() => flow),
        createManaged: vi.fn((input: Record<string, unknown>) => {
          flow = {
            ...input,
            flowId: "flow-pending-recovery",
            syncMode: "managed",
            ownerKey: "agent:main:telegram:direct:requester",
            requesterOrigin: { channel: "telegram", to: "requester" },
            revision: 1,
          };
          return flow;
        }),
        resume: vi.fn((input: Record<string, unknown>) => {
          flow = { ...flow, ...input, status: "running", revision: 2 };
          return { applied: true as const, flow };
        }),
        setWaiting: vi.fn((input: Record<string, unknown>) => {
          flow = { ...flow, ...input, status: "waiting", revision: Number(flow?.revision) + 1 };
          return { applied: true as const, flow };
        }),
      }));

      await reconcileInterruptedWorkboardCards({
        store,
        subagent: {
          ...unknownRecoveryRuntime(run),
          getRunState: vi.fn(async ({ runId: queriedRunId }: { runId: string }) =>
            activeRuns.has(queriedRunId)
              ? { status: "active" as const }
              : { status: "absent" as const },
          ),
        },
        managedFlows: { bindSession } as never,
        sessions: { getSessionEntry: vi.fn() },
        worktrees: { create, release: vi.fn(), removeIfLossless: vi.fn() },
        options: { now: 20, allowManagedWorktrees: true },
      });

      expect(create).toHaveBeenCalledOnce();
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          repoRoot: "/repo",
          baseRef: "main",
          ownerKind: "workboard",
          ownerId: card.id,
        }),
      );
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: runId,
          cwd: managedPath,
          parentFlowId: "flow-pending-recovery",
          flowOwnerSessionKey: "agent:main:telegram:direct:requester",
        }),
      );
      expect(run.mock.calls[0]?.[0]).not.toMatchObject({ cwd: "/repo" });
    },
  );

  it("starts a local retry only after core explicitly exhausts restart ownership", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Restart-safe worker",
      status: "ready",
      agentId: "main",
    });
    const initialRun = createEchoRun();
    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: initialRun },
      options: { now: 10, maxStarts: 1 },
    });
    const predecessorRunId = initialRun.mock.calls[0]?.[0].idempotencyKey!;
    await expect(store.get(card.id)).resolves.toMatchObject({
      metadata: {
        automation: {
          idempotencyKey: `workboard:${card.id}:workflow`,
          maxRetries: 2,
        },
      },
    });
    const retryRun = createEchoRun();

    const result = await reconcileInterruptedWorkboardCards({
      store,
      subagent: {
        ...unknownRecoveryRuntime(retryRun),
        getRunState: vi.fn().mockResolvedValue({
          status: "terminal",
          outcome: "error",
          error: "gateway closed (1012): service restart",
        }),
        getRecoveryOwnership: vi.fn().mockResolvedValue({ status: "exhausted" }),
      },
      sessions: { getSessionEntry: vi.fn() },
      options: { now: 20 },
    });

    expect(result.reconciled).toEqual([card.id]);
    expect(result.started).toEqual([expect.objectContaining({ cardId: card.id })]);
    expect(retryRun).toHaveBeenCalledOnce();
    expect(retryRun.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: `agent:main:subagent:workboard-default-${card.id}`,
      lane: `workboard:default:${card.id}`,
      deliver: false,
    });
    const successorRunId = retryRun.mock.calls[0]?.[0].idempotencyKey;
    expect(successorRunId).not.toBe(predecessorRunId);
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      runId: successorRunId,
      execution: { status: "running", runId: successorRunId },
      metadata: { failureCount: 1 },
    });
  });

  it("keeps recovery overflow durable and starts it in a later bounded batch", async () => {
    vi.useFakeTimers();
    const store = new WorkboardStore(createMemoryStore());
    for (let index = 0; index < 4; index += 1) {
      await store.create({
        title: `Restart-safe worker ${index}`,
        status: "ready",
        agentId: `agent-${index}`,
        idempotencyKey: `restart-safe:${index}`,
        maxRetries: 2,
      });
    }
    const initialRun = createEchoRun();
    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: initialRun },
      options: { now: 10, maxStarts: 4 },
    });
    const predecessorRunIds = new Set(
      initialRun.mock.calls.map(([runParams]) => runParams.idempotencyKey),
    );

    const activeSuccessors = new Set<string>();
    const retryRun = vi.fn(async (runParams: TestRunParams) => {
      const runId = runParams.idempotencyKey!;
      activeSuccessors.add(runId);
      return { runId };
    });
    const recoveryParams = {
      store,
      subagent: {
        ...unknownRecoveryRuntime(retryRun),
        getRunState: vi.fn(async ({ runId }: { runId: string }) =>
          activeSuccessors.has(runId)
            ? { status: "active" as const }
            : {
                status: "terminal" as const,
                outcome: "error" as const,
                error: "gateway closed (1012): service restart",
              },
        ),
        getRecoveryOwnership: vi.fn(async ({ runId }: { runId: string }) =>
          predecessorRunIds.has(runId)
            ? { status: "exhausted" as const }
            : { status: "unknown" as const },
        ),
      },
      sessions: { getSessionEntry: vi.fn() },
      options: { now: 20 },
    };
    const results: Awaited<ReturnType<typeof reconcileInterruptedWorkboardCards>>[] = [];
    const controller = createWorkboardRecoveryController({
      runRecovery: async () => {
        const result = await reconcileInterruptedWorkboardCards(recoveryParams);
        results.push(result);
        return result;
      },
      settleTerminatedRun: vi.fn(),
      cleanupRun: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
      continuationDelayMs: 25,
    });

    await controller.request("startup");
    expect(results[0]?.started).toHaveLength(3);
    expect(results[0]?.continuationMode).toBe("bounded");
    await vi.advanceTimersByTimeAsync(25);
    expect(results[1]?.started).toHaveLength(1);
    expect(results[1]?.needsContinuation).toBe(true);
    expect(results[1]?.continuationMode).toBe("durable");
    expect(retryRun).toHaveBeenCalledTimes(4);
  });

  it("queries every pending marker so unknown early cards cannot starve a later accepted run", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const cards = [];
    for (let index = 0; index < 4; index += 1) {
      cards.push(
        await store.create({
          title: `Pending start ${index}`,
          status: "ready",
          agentId: `pending-agent-${index}`,
        }),
      );
    }
    const rejectedRun = vi.fn().mockRejectedValue(new Error("response lost"));
    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: rejectedRun },
      options: { maxStarts: 4 },
    });
    const fourth = (await store.get(cards[3]!.id))!;
    const fourthRunId = fourth.metadata?.automation?.startIdempotencyKey;
    const getRunState = vi.fn(async ({ runId }: { runId: string }) =>
      runId === fourthRunId ? { status: "active" as const } : { status: "unknown" as const },
    );

    const result = await reconcileInterruptedWorkboardCards({
      store,
      subagent: { ...unknownRecoveryRuntime(), getRunState },
      sessions: { getSessionEntry: vi.fn() },
    });

    expect(new Set(getRunState.mock.calls.map(([query]) => query.runId))).toEqual(
      new Set(rejectedRun.mock.calls.map(([runParams]) => runParams.idempotencyKey)),
    );
    expect(result.started).toEqual([
      expect.objectContaining({ cardId: cards[3]!.id, runId: fourthRunId }),
    ]);
    expect(result.continuationMode).toBe("durable");
    await expect(store.get(cards[3]!.id)).resolves.toMatchObject({
      status: "running",
      execution: { status: "running", runId: fourthRunId },
    });
  });

  it("maps an accepted run after its response is lost without invoking it twice", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Accepted response-loss worker", status: "ready" });
    const run = vi.fn().mockRejectedValue(new Error("transport closed after acceptance"));
    const dispatch = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 1 },
    });
    expect(dispatch.needsReconciliation).toBe(true);
    const pending = (await store.get(card.id))!;
    const runId = pending.metadata?.automation?.startIdempotencyKey;

    const result = await reconcileInterruptedWorkboardCards({
      store,
      subagent: {
        ...unknownRecoveryRuntime(run),
        getRunState: vi.fn().mockResolvedValue({ status: "active" }),
      },
      sessions: { getSessionEntry: vi.fn() },
    });

    expect(run).toHaveBeenCalledOnce();
    expect(result.started).toEqual([expect.objectContaining({ cardId: card.id, runId })]);
    await expect(store.get(card.id)).resolves.toMatchObject({
      runId,
      execution: { status: "running", runId },
    });
    expect((await store.get(card.id))?.metadata?.automation?.startIdempotencyKey).toBeUndefined();
  });

  it("continues when an accepted response-loss run terminates with 1012 before mapping", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Fast interrupted response-loss worker",
      status: "ready",
      idempotencyKey: "fast-interrupted:1",
      maxRetries: 2,
    });
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockImplementation(async (runParams: TestRunParams) => ({
        runId: runParams.idempotencyKey!,
      }));
    await dispatchAndStartWorkboardCards({ store, subagent: { run }, options: { maxStarts: 1 } });
    const interruptedRunId = (await store.get(card.id))?.metadata?.automation?.startIdempotencyKey;
    const activeRuns = new Set<string>();
    run.mockImplementation(async (runParams: TestRunParams) => {
      const runId = runParams.idempotencyKey!;
      activeRuns.add(runId);
      return { runId };
    });
    const result = await reconcileInterruptedWorkboardCards({
      store,
      subagent: {
        ...unknownRecoveryRuntime(run),
        getRunState: vi.fn(async ({ runId }: { runId: string }) =>
          activeRuns.has(runId)
            ? { status: "active" as const }
            : {
                status: "terminal" as const,
                outcome: "error" as const,
                error: "gateway closed (1012): service restart",
              },
        ),
        getRecoveryOwnership: vi.fn().mockResolvedValue({ status: "exhausted" }),
      },
      sessions: { getSessionEntry: vi.fn() },
    });

    expect(result.started).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0].idempotencyKey).not.toBe(interruptedRunId);
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      metadata: { failureCount: 1 },
    });
  });

  it("polls core ownership beyond the bounded continuation cap and maps one successor", async () => {
    vi.useFakeTimers();
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Core-owned restart",
      status: "ready",
      idempotencyKey: "core-owned:1",
      maxRetries: 2,
    });
    const initialRun = createEchoRun();
    await dispatchAndStartWorkboardCards({ store, subagent: { run: initialRun } });
    const predecessorRunId = initialRun.mock.calls[0]?.[0].idempotencyKey!;
    const remap = vi.spyOn(store, "remapRecoveredSuccessor");
    let ownershipCalls = 0;
    const recoveryParams = {
      store,
      subagent: {
        ...unknownRecoveryRuntime(),
        // A stale predecessor registry row can still appear active while the
        // exact successor has already terminated. Ownership must win first.
        getRunState: vi.fn(async ({ runId }: { runId: string }) =>
          runId === "successor-run"
            ? {
                status: "terminal" as const,
                outcome: "error" as const,
                error: "successor failed before Workboard remapped it",
              }
            : { status: "active" as const },
        ),
        getRecoveryOwnership: vi.fn(async () => {
          ownershipCalls += 1;
          return ownershipCalls <= 5
            ? { status: "core_owned" as const }
            : { status: "successor" as const, successorRunId: "successor-run" };
        }),
      },
      sessions: { getSessionEntry: vi.fn() },
    };
    const controller = createWorkboardRecoveryController({
      runRecovery: async () => await reconcileInterruptedWorkboardCards(recoveryParams),
      settleTerminatedRun: vi.fn(),
      cleanupRun: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
      continuationDelayMs: 10,
      durableContinuationMaxDelayMs: 40,
      maxContinuationPasses: 2,
    });

    await controller.request("startup");
    await vi.advanceTimersByTimeAsync(160);

    expect(ownershipCalls).toBe(6);
    expect(remap).toHaveBeenCalledTimes(1);
    expect(remap).toHaveBeenCalledWith(
      card.id,
      expect.objectContaining({
        expectedRunId: predecessorRunId,
        successorRunId: "successor-run",
      }),
    );
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "blocked",
      runId: "successor-run",
      execution: { status: "blocked", runId: "successor-run" },
    });
  });

  it("keeps polling an active predecessor until core publishes its restart successor", async () => {
    vi.useFakeTimers();
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Hard-restart predecessor",
      status: "ready",
      idempotencyKey: "hard-restart:1",
      maxRetries: 2,
    });
    const initialRun = createEchoRun();
    await dispatchAndStartWorkboardCards({ store, subagent: { run: initialRun } });
    const predecessorRunId = initialRun.mock.calls[0]?.[0].idempotencyKey!;
    const remap = vi.spyOn(store, "remapRecoveredSuccessor");
    let ownershipCalls = 0;
    const recoveryParams = {
      store,
      subagent: {
        ...unknownRecoveryRuntime(),
        getRunState: vi.fn().mockResolvedValue({ status: "active" as const }),
        getRecoveryOwnership: vi.fn(async () => {
          ownershipCalls += 1;
          return ownershipCalls <= 5
            ? { status: "unknown" as const }
            : { status: "successor" as const, successorRunId: "successor-run" };
        }),
      },
      sessions: { getSessionEntry: vi.fn() },
    };
    const controller = createWorkboardRecoveryController({
      runRecovery: async () => await reconcileInterruptedWorkboardCards(recoveryParams),
      settleTerminatedRun: vi.fn(),
      cleanupRun: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
      continuationDelayMs: 10,
      durableContinuationMaxDelayMs: 40,
      maxContinuationPasses: 2,
    });

    await controller.request("startup");
    await vi.advanceTimersByTimeAsync(160);

    expect(ownershipCalls).toBe(6);
    expect(remap).toHaveBeenCalledTimes(1);
    expect(remap).toHaveBeenCalledWith(
      card.id,
      expect.objectContaining({
        expectedRunId: predecessorRunId,
        successorRunId: "successor-run",
      }),
    );
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      runId: "successor-run",
      execution: { status: "running", runId: "successor-run" },
    });
  });

  it("keeps a core-created successor in the same managed TaskFlow", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Managed core successor",
      status: "ready",
      agentId: "main",
      idempotencyKey: "managed-core-successor",
      maxRetries: 2,
      requesterSessionKey: "agent:main:telegram:direct:requester",
      requesterOrigin: { channel: "telegram", to: "requester" },
    });
    let flow: Record<string, unknown> | undefined;
    const setWaiting = vi.fn((input: Record<string, unknown>) => {
      flow = {
        ...flow,
        ...input,
        status: "waiting",
        revision: Number(flow?.revision) + 1,
      };
      return { applied: true as const, flow };
    });
    const bindSession = vi.fn(() => ({
      sessionKey: "agent:main:telegram:direct:requester",
      list: vi.fn(() => (flow ? [flow] : [])),
      get: vi.fn(() => flow),
      createManaged: vi.fn((input: Record<string, unknown>) => {
        flow = {
          ...input,
          flowId: "flow-core-successor",
          syncMode: "managed",
          ownerKey: "agent:main:telegram:direct:requester",
          requesterOrigin: { channel: "telegram", to: "requester" },
          revision: 1,
        };
        return flow;
      }),
      resume: vi.fn(),
      setWaiting,
    }));
    const initialRun = createEchoRun();
    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: initialRun } as never,
      managedFlows: { bindSession } as never,
      options: { now: 10, maxStarts: 1 },
    });
    const predecessorRunId = initialRun.mock.calls[0]?.[0].idempotencyKey!;

    await reconcileInterruptedWorkboardCards({
      store,
      subagent: {
        ...unknownRecoveryRuntime(),
        getRecoveryOwnership: vi.fn().mockResolvedValue({
          status: "successor" as const,
          successorRunId: "run-r2",
        }),
        getRunState: vi.fn().mockResolvedValue({ status: "active" as const }),
      },
      managedFlows: { bindSession } as never,
      sessions: { getSessionEntry: vi.fn() },
      options: { now: 20 },
    });

    expect(setWaiting).toHaveBeenCalledTimes(2);
    expect(setWaiting).toHaveBeenLastCalledWith(
      expect.objectContaining({
        flowId: "flow-core-successor",
        waitJson: expect.objectContaining({ runId: "run-r2" }),
      }),
    );
    await expect(store.get(card.id)).resolves.toMatchObject({
      runId: "run-r2",
      metadata: {
        automation: {
          flowId: "flow-core-successor",
          flowRevision: 3,
        },
      },
    });
    expect(predecessorRunId).not.toBe("run-r2");
  });

  it("settles a terminal success missed by the previous controller instance", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Missed terminal success",
      status: "running",
      idempotencyKey: "missed-success:1",
      maxRetries: 2,
      sessionKey: "agent:main:subagent:missed-success",
      runId: "run-missed-success",
      execution: {
        id: "exec-missed-success",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "default",
        sessionKey: "agent:main:subagent:missed-success",
        runId: "run-missed-success",
        startedAt: 10,
        updatedAt: 10,
      },
    });
    await store.update(card.id, {
      metadata: { ...card.metadata, failureCount: 2 },
    });
    const retryRun = createEchoRun();

    await reconcileInterruptedWorkboardCards({
      store,
      subagent: {
        ...unknownRecoveryRuntime(retryRun),
        getRunState: vi.fn().mockResolvedValue({ status: "terminal", outcome: "ok" }),
      },
      sessions: { getSessionEntry: vi.fn().mockReturnValue({ status: "done" }) },
    });

    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "blocked",
      execution: { status: "blocked" },
    });
    expect(retryRun).not.toHaveBeenCalled();
  });

  it("maps and cleans a terminal response-loss worktree", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Terminal response-loss worktree",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo", branch: "main" },
    });
    const worktrees = {
      create: vi.fn().mockResolvedValue({
        id: "response-loss-worktree",
        path: "/state/worktrees/response-loss",
        branch: `openclaw/wb-${card.id}`,
      }),
      release: vi.fn(),
      removeIfLossless: vi.fn().mockResolvedValue(true),
    };
    const run = vi.fn().mockRejectedValue(new Error("response lost after acceptance"));
    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees,
      options: { maxStarts: 1 },
    });

    await reconcileInterruptedWorkboardCards({
      store,
      subagent: {
        ...unknownRecoveryRuntime(run),
        getRunState: vi.fn().mockResolvedValue({ status: "terminal", outcome: "ok" }),
      },
      sessions: { getSessionEntry: vi.fn() },
      worktrees,
    });

    expect(run).toHaveBeenCalledOnce();
    expect(worktrees.removeIfLossless).toHaveBeenCalledWith({
      path: "/state/worktrees/response-loss",
    });
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "blocked" });
  });

  it("cleans a pending-start worktree once after three exact absence failures", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Definitely absent worktree worker",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo", branch: "main" },
    });
    const worktrees = {
      create: vi.fn().mockResolvedValue({
        id: "absent-worktree",
        path: "/state/worktrees/absent-worker",
        branch: `openclaw/wb-${card.id}`,
      }),
      release: vi.fn(),
      removeIfLossless: vi.fn().mockResolvedValue(true),
    };
    const run = vi.fn().mockRejectedValue(new Error("runtime rejected before acceptance"));
    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      worktrees,
      options: { maxStarts: 1 },
    });
    const recoveryParams = {
      store,
      subagent: {
        ...unknownRecoveryRuntime(run),
        getRunState: vi.fn().mockResolvedValue({ status: "absent" as const }),
      },
      sessions: { getSessionEntry: vi.fn() },
      worktrees,
    };

    await reconcileInterruptedWorkboardCards(recoveryParams);
    await reconcileInterruptedWorkboardCards(recoveryParams);
    expect(worktrees.removeIfLossless).not.toHaveBeenCalled();
    await reconcileInterruptedWorkboardCards(recoveryParams);

    expect(worktrees.removeIfLossless).toHaveBeenCalledTimes(1);
    expect(worktrees.removeIfLossless).toHaveBeenCalledWith({
      path: "/state/worktrees/absent-worker",
    });
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "blocked" });
  });

  it("preserves a live successor when persistence fails after subagent acceptance", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Accepted successor",
      status: "ready",
      idempotencyKey: "accepted-successor:1",
      maxRetries: 2,
      workspace: { kind: "worktree", path: "/repo", branch: "main" },
    });
    vi.spyOn(store, "recordStartedWorker").mockRejectedValue(
      new Error("mapping persistence unavailable"),
    );
    const block = vi.spyOn(store, "block");
    const releaseClaim = vi.spyOn(store, "releaseClaim");
    const worktrees = {
      create: vi.fn().mockResolvedValue({
        id: "accepted-worktree",
        path: "/state/worktrees/accepted-successor",
        branch: `openclaw/wb-${card.id}`,
      }),
      release: vi.fn(),
      removeIfLossless: vi.fn().mockResolvedValue(true),
    };

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn().mockResolvedValue({ runId: "run-accepted-successor" }) },
      worktrees,
      options: { maxStarts: 1, recoveryMode: true },
    });

    expect(result.startFailures).toEqual([
      expect.objectContaining({ cardId: card.id, error: "mapping persistence unavailable" }),
    ]);
    expect(block).not.toHaveBeenCalled();
    expect(releaseClaim).not.toHaveBeenCalled();
    expect(worktrees.removeIfLossless).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      metadata: { claim: expect.objectContaining({ token: expect.any(String) }) },
    });
  });

  it("visibly blocks a worker that terminates without completing its running card", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Promise-only worker",
      status: "running",
      sessionKey: "agent:main:subagent:promise-only",
      runId: "run-promise-only",
      execution: {
        id: "exec-promise-only",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "default",
        sessionKey: "agent:main:subagent:promise-only",
        runId: "run-promise-only",
        startedAt: 10,
        updatedAt: 10,
      },
    });

    const settled = await settleTerminatedWorkboardRun({
      store,
      event: {
        targetSessionKey: "agent:main:subagent:promise-only",
        runId: "run-promise-only",
        outcome: "ok",
      },
    });

    expect(settled).toMatchObject({
      status: "settled",
      card: {
        id: card.id,
        status: "blocked",
        execution: { status: "blocked", runId: "run-promise-only" },
        metadata: {
          workerProtocol: {
            state: "violated",
            detail: expect.stringContaining("without completing or blocking"),
          },
        },
      },
    });
  });

  it("leaves terminal settlement to a core-owned verified completion before card projection", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Armed before projection",
      status: "running",
      sessionKey: "agent:main:subagent:armed",
      runId: "run-armed",
      execution: {
        id: "exec-armed",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "default",
        sessionKey: "agent:main:subagent:armed",
        runId: "run-armed",
        startedAt: 10,
        updatedAt: 10,
      },
    });
    const getRunState = vi.fn(async () => ({
      status: "terminal" as const,
      outcome: "ok" as const,
      deliveryStatus: "pending" as const,
      verifiedCompletionIntent: { cardId: card.id },
    }));

    const settled = await settleTerminatedWorkboardRun({
      store,
      subagent: {
        getRecoveryOwnership: vi.fn(async () => ({ status: "unknown" as const })),
        getRunState,
      } as never,
      event: {
        targetSessionKey: "agent:main:subagent:armed",
        runId: "run-armed",
        outcome: "ok",
      },
    });

    expect(settled).toMatchObject({ status: "completion-owned", card: { id: card.id } });
    expect(getRunState).toHaveBeenCalledWith({
      sessionKey: "agent:main:subagent:armed",
      runId: "run-armed",
    });
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      execution: { status: "running" },
    });
  });

  it("does not overwrite a card revision that completes while its terminal event settles", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Finishing worker",
      status: "running",
      sessionKey: "agent:main:subagent:finishing",
      runId: "run-finishing",
      execution: {
        id: "exec-finishing",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "default",
        sessionKey: "agent:main:subagent:finishing",
        runId: "run-finishing",
        startedAt: 10,
        updatedAt: 10,
      },
    });
    const originalSettle = store.settleTerminatedWorker.bind(store);
    vi.spyOn(store, "settleTerminatedWorker").mockImplementationOnce(async (id, input) => {
      await store.update(card.id, {
        status: "done",
        execution: {
          ...card.execution!,
          status: "done",
          updatedAt: 20,
        },
      });
      return await originalSettle(id, input);
    });

    const settled = await settleTerminatedWorkboardRun({
      store,
      event: {
        targetSessionKey: "agent:main:subagent:finishing",
        runId: "run-finishing",
        outcome: "ok",
      },
    });

    expect(settled.status).toBe("already-terminal");
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "done",
      execution: { status: "done" },
    });
  });

  it("does not let a stale predecessor event block a successor on the same session", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Restarted worker",
      status: "running",
      sessionKey: "agent:main:subagent:restarted",
      runId: "run-after-restart",
      execution: {
        id: "exec-restarted",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "default",
        sessionKey: "agent:main:subagent:restarted",
        runId: "run-after-restart",
        startedAt: 10,
        updatedAt: 10,
      },
    });

    const settled = await settleTerminatedWorkboardRun({
      store,
      event: {
        targetSessionKey: "agent:main:subagent:restarted",
        runId: "run-before-restart",
        outcome: "error",
        error: "worker stopped",
      },
    });

    expect(settled).toMatchObject({
      status: "superseded",
      card: { id: card.id, status: "running", runId: "run-after-restart" },
    });
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      execution: { status: "running", runId: "run-after-restart" },
    });
  });

  it.each([
    { staleRunId: "run-r1", currentRunId: "run-r2" },
    { staleRunId: "run-r2", currentRunId: "run-r3" },
  ])(
    "recognizes stale lineage event $staleRunId after remapping $currentRunId",
    async ({ staleRunId, currentRunId }) => {
      const store = new WorkboardStore(createMemoryStore());
      const sessionKey = "agent:main:subagent:lineage-stale";
      const card = await store.create({
        title: "Multi-generation worker",
        status: "running",
        sessionKey,
        runId: currentRunId,
        execution: {
          id: "exec-lineage-stale",
          kind: "agent-session",
          engine: "codex",
          mode: "autonomous",
          status: "running",
          model: "default",
          sessionKey,
          runId: currentRunId,
          startedAt: 10,
          updatedAt: 10,
        },
      });
      const getRecoveryOwnership = vi.fn(async ({ runId }: { runId: string }) =>
        runId === staleRunId
          ? { status: "successor" as const, successorRunId: currentRunId }
          : { status: "unknown" as const },
      );

      const result = await settleTerminatedWorkboardRun({
        store,
        subagent: { getRecoveryOwnership },
        event: { targetSessionKey: sessionKey, runId: staleRunId, outcome: "error" },
      });

      expect(result).toMatchObject({ status: "superseded", card: { id: card.id } });
      expect(getRecoveryOwnership).toHaveBeenCalledOnce();
      await expect(store.get(card.id)).resolves.toMatchObject({
        status: "running",
        runId: currentRunId,
      });
    },
  );

  it("remaps an exact terminal successor event before settling it", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const sessionKey = "agent:main:subagent:terminal-successor";
    const card = await store.create({
      title: "Terminal successor",
      status: "running",
      sessionKey,
      runId: "run-r1",
      execution: {
        id: "exec-terminal-successor",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "default",
        sessionKey,
        runId: "run-r1",
        startedAt: 10,
        updatedAt: 10,
      },
    });
    const getRecoveryOwnership = vi.fn(async ({ runId }: { runId: string }) =>
      runId === "run-r1"
        ? { status: "successor" as const, successorRunId: "run-r2" }
        : { status: "unknown" as const },
    );

    const result = await settleTerminatedWorkboardRun({
      store,
      subagent: { getRecoveryOwnership },
      event: {
        targetSessionKey: sessionKey,
        runId: "run-r2",
        outcome: "error",
        error: "worker failed",
      },
    });

    expect(result.status).toBe("settled");
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "blocked",
      runId: "run-r2",
      execution: { status: "blocked", runId: "run-r2" },
    });
  });

  it("retries terminal settlement after an unrelated running-card revision", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Revision-racing worker",
      status: "running",
      sessionKey: "agent:main:subagent:revision-race",
      runId: "run-revision-race",
      execution: {
        id: "exec-revision-race",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "default",
        sessionKey: "agent:main:subagent:revision-race",
        runId: "run-revision-race",
        startedAt: 10,
        updatedAt: 10,
      },
    });
    const originalSettle = store.settleTerminatedWorker.bind(store);
    const settle = vi
      .spyOn(store, "settleTerminatedWorker")
      .mockImplementationOnce(async (id, input) => {
        await store.addWorkerLog(id, { message: "Late heartbeat-adjacent log." });
        return await originalSettle(id, input);
      });

    const result = await settleTerminatedWorkboardRun({
      store,
      event: {
        targetSessionKey: "agent:main:subagent:revision-race",
        runId: "run-revision-race",
        outcome: "ok",
      },
    });

    expect(result.status).toBe("settled");
    expect(settle).toHaveBeenCalledTimes(2);
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "blocked" });
  });

  it("leaves restart-interrupted workers running for bounded reconciliation", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Gateway restart worker",
      status: "running",
      sessionKey: "agent:main:subagent:gateway-restart",
      runId: "run-gateway-restart",
      execution: {
        id: "exec-gateway-restart",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "default",
        sessionKey: "agent:main:subagent:gateway-restart",
        runId: "run-gateway-restart",
        startedAt: 10,
        updatedAt: 10,
      },
    });

    const settled = await settleTerminatedWorkboardRun({
      store,
      event: {
        targetSessionKey: "agent:main:subagent:gateway-restart",
        runId: "run-gateway-restart",
        outcome: "error",
        error: "gateway closed (1012): service restart",
      },
    });

    expect(settled.status).toBe("recoverable");
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      execution: { status: "running" },
    });
  });
});
