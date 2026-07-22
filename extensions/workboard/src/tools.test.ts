// Workboard tests cover tools plugin behavior.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { WorkboardStore, type PersistedWorkboardCard, type WorkboardKeyedStore } from "./store.js";
import { createWorkboardTools } from "./tools.js";

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

function readPayload(result: unknown): Record<string, unknown> {
  return (result as { details?: Record<string, unknown> }).details ?? {};
}

function createDispatchApi(keyed: WorkboardKeyedStore) {
  const flows = new Map<string, Record<string, unknown>>();
  const run = vi.fn(async (params: { idempotencyKey?: string }) => ({
    runId: params.idempotencyKey!,
  }));
  const resolveOwnerSession = vi.fn(async ({ sessionKey }: { sessionKey: string }) => ({
    status: "resolved" as const,
    workerSessionKey: sessionKey.startsWith("agent:") ? sessionKey : `agent:main:${sessionKey}`,
    ownerSessionKey: "agent:main:main",
    workspaceDir: "/tmp/canonical-worker-workspace",
  }));
  const bindSession = vi.fn(
    ({ sessionKey, requesterOrigin }: { sessionKey: string; requesterOrigin?: unknown }) => ({
      sessionKey,
      list: vi.fn(() => [...flows.values()]),
      get: vi.fn((flowId: string) => flows.get(flowId)),
      createManaged: vi.fn((input: Record<string, unknown>) => {
        const flowId = `flow-${flows.size + 1}`;
        const flow = {
          ...input,
          flowId,
          syncMode: "managed",
          ownerKey: sessionKey,
          requesterOrigin,
          revision: 1,
        };
        flows.set(flowId, flow);
        return flow;
      }),
      resume: vi.fn((input: { flowId: string }) => {
        const current = flows.get(input.flowId)!;
        const flow = { ...current, status: "running", revision: Number(current.revision) + 1 };
        flows.set(input.flowId, flow);
        return { applied: true, flow };
      }),
      setWaiting: vi.fn(
        (input: {
          flowId: string;
          currentStep?: string;
          stateJson?: unknown;
          waitJson?: unknown;
        }) => {
          const current = flows.get(input.flowId)!;
          const flow = {
            ...current,
            status: "waiting",
            revision: Number(current.revision) + 1,
            currentStep: input.currentStep,
            stateJson: input.stateJson,
            waitJson: input.waitJson,
          };
          flows.set(input.flowId, flow);
          return { applied: true, flow };
        },
      ),
      fail: vi.fn(
        (input: {
          flowId: string;
          stateJson?: unknown;
          blockedSummary?: string;
          endedAt?: number;
        }) => {
          const current = flows.get(input.flowId)!;
          const flow = {
            ...current,
            status: "failed",
            revision: Number(current.revision) + 1,
            stateJson: input.stateJson,
            blockedSummary: input.blockedSummary,
            endedAt: input.endedAt,
          };
          flows.set(input.flowId, flow);
          return { applied: true, flow };
        },
      ),
    }),
  );
  const api = {
    runtime: {
      state: { openKeyedStore: vi.fn(() => keyed) },
      subagent: { run, resolveOwnerSession },
      tasks: { managedFlows: { bindSession } },
      worktrees: {
        create: vi.fn(),
        release: vi.fn(),
        removeIfLossless: vi.fn(),
      },
    },
  } as unknown as OpenClawPluginApi;
  return { api, run, bindSession, resolveOwnerSession, flows };
}

describe("workboard tools", () => {
  it("terminalizes and detaches a managed flow when its worker blocks", async () => {
    const keyed = createMemoryStore();
    const { api, flows } = createDispatchApi(keyed);
    const store = new WorkboardStore(keyed);
    const tools = new Map(
      createWorkboardTools({
        api,
        store,
        context: {
          agentId: "main",
          sessionKey: "agent:main:telegram:direct:requester",
          deliveryContext: { channel: "telegram", to: "requester" },
          workspaceDir: "/tmp/requester-workspace",
        } as never,
      }).map((tool) => [tool.name, tool]),
    );
    const created = readPayload(
      await tools.get("workboard_create")?.execute("create-blocked", {
        title: "Managed blocker",
        status: "ready",
      }),
    ).card as { id: string };
    await tools.get("workboard_dispatch")?.execute("dispatch-blocked", {});
    const running = await store.get(created.id);
    const token = running?.metadata?.claim?.token;
    const flowId = running?.metadata?.automation?.flowId;
    const workflowIdempotencyKey = running?.metadata?.automation?.idempotencyKey;
    if (!token || !flowId || !workflowIdempotencyKey) {
      throw new Error("expected dispatched managed Workboard identity");
    }

    await tools.get("workboard_block")?.execute("block-managed", {
      id: created.id,
      token,
      reason: "Waiting for operator input.",
    });

    expect(flows.get(flowId)).toMatchObject({
      status: "failed",
      blockedSummary: "Waiting for operator input.",
      stateJson: expect.objectContaining({ phase: "failed", runId: running?.runId }),
    });
    const blocked = await store.get(created.id);
    expect(blocked).toMatchObject({ status: "blocked", execution: { status: "blocked" } });
    expect(blocked?.metadata?.automation).not.toHaveProperty("flowId");
    expect(blocked?.metadata?.automation).not.toHaveProperty("flowOwnerSessionKey");
    expect(blocked?.metadata?.automation).not.toHaveProperty("controllerId");
    expect(blocked?.metadata?.automation?.idempotencyKey).not.toBe(workflowIdempotencyKey);
    await expect(store.unblock(created.id)).resolves.toMatchObject({ status: "todo" });
  });

  it("lists, claims, heartbeats, and reads worker context", async () => {
    const keyed = createMemoryStore();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => keyed),
        },
      },
    } as unknown as OpenClawPluginApi;
    const workboardStore = new WorkboardStore(keyed);
    const tools = createWorkboardTools({
      api,
      store: workboardStore,
      context: { agentId: "main", sessionKey: "session-1" } as never,
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const store = keyed;
    await store.register("card-1", {
      version: 1,
      card: {
        id: "card-1",
        title: "Ship coordination",
        status: "todo",
        priority: "normal",
        labels: [],
        agentId: "main",
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
        events: [{ id: "event-card-1", kind: "created", at: 1 }],
      },
    });
    await store.register("archived-1", {
      version: 1,
      card: {
        id: "archived-1",
        title: "Closed work",
        status: "done",
        priority: "normal",
        labels: [],
        position: 2000,
        createdAt: 1,
        updatedAt: 1,
        metadata: { archivedAt: 2 },
      },
    });

    const claimed = readPayload(
      await byName.get("workboard_claim")?.execute("call-1", { id: "card-1" }),
    );
    expect(claimed.card).toMatchObject({
      status: "running",
      metadata: { claim: { ownerId: "main", token: "[redacted]" } },
    });
    const token = (claimed.token as string | undefined) ?? "";

    const heartbeat = readPayload(
      await byName
        .get("workboard_heartbeat")
        ?.execute("call-2", { id: "card-1", token, note: "alive" }),
    );
    expect(heartbeat).toMatchObject({
      metadata: { comments: [expect.objectContaining({ body: "alive" })] },
    });

    const read = readPayload(
      await byName.get("workboard_read")?.execute("call-3", { id: "card-1" }),
    );
    expect(read.workerContext).toContain("Ship coordination");
    expect(read.card).toMatchObject({ metadata: { claim: { token: "[redacted]" } } });

    const released = readPayload(
      await byName
        .get("workboard_release")
        ?.execute("call-4", { id: "card-1", token, status: "review" }),
    );
    expect(released).toMatchObject({ status: "review" });
    expect((released.metadata as { claim?: unknown } | undefined)?.claim).toBeUndefined();

    const list = readPayload(await byName.get("workboard_list")?.execute("call-5", {}));
    expect(list.cards).toEqual([expect.objectContaining({ id: "card-1" })]);
    const archivedList = readPayload(
      await byName.get("workboard_list")?.execute("call-6", { includeArchived: true }),
    );
    expect(archivedList.cards).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "archived-1", archivedAt: 2 })]),
    );
  });

  it("can share one store across tool instances for claim coordination", async () => {
    const keyed = createMemoryStore();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => keyed),
        },
      },
    } as unknown as OpenClawPluginApi;
    const store = new WorkboardStore(keyed);
    const mainTools = new Map(
      createWorkboardTools({
        api,
        store,
        context: { agentId: "main" } as never,
      }).map((tool) => [tool.name, tool]),
    );
    const otherTools = new Map(
      createWorkboardTools({
        api,
        store,
        context: { agentId: "other" } as never,
      }).map((tool) => [tool.name, tool]),
    );
    const card = await store.create({ title: "Single owner" });

    await mainTools.get("workboard_claim")?.execute("call-1", { id: card.id });

    await expect(
      otherTools.get("workboard_claim")?.execute("call-2", { id: card.id }),
    ).rejects.toThrow(/already claimed/);
  });

  it("requires claim scope before creating or linking dependencies against claimed cards", async () => {
    const keyed = createMemoryStore();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => keyed),
        },
      },
    } as unknown as OpenClawPluginApi;
    const store = new WorkboardStore(keyed);
    const mainTools = new Map(
      createWorkboardTools({
        api,
        store,
        context: { agentId: "main" } as never,
      }).map((tool) => [tool.name, tool]),
    );
    const otherTools = new Map(
      createWorkboardTools({
        api,
        store,
        context: { agentId: "other" } as never,
      }).map((tool) => [tool.name, tool]),
    );
    const parent = await store.create({ title: "Claimed parent" });
    const claimed = await store.claim(parent.id, { ownerId: "main", token: "parent-token" });

    await expect(
      otherTools.get("workboard_create")?.execute("call-1", {
        title: "Blocked child",
        parents: [parent.id],
      }),
    ).rejects.toThrow(/claimed by main/);
    await expect(
      otherTools.get("workboard_create")?.execute("call-1b", {
        title: "Blocked child",
        parents: parent.id,
      }),
    ).rejects.toThrow(/claimed by main/);
    expect(await store.list()).toHaveLength(1);

    await otherTools.get("workboard_create")?.execute("call-2", {
      title: "Scoped child",
      parents: [parent.id],
      token: claimed.token,
    });
    const child = await store.create({ title: "Claimed child" });
    await store.claim(child.id, { ownerId: "main", token: "child-token" });
    await expect(
      otherTools.get("workboard_link")?.execute("call-3", {
        parentId: parent.id,
        childId: child.id,
      }),
    ).rejects.toThrow(/claimed by main/);

    const linked = readPayload(
      await otherTools.get("workboard_link")?.execute("call-4", {
        parentId: parent.id,
        childId: (await store.create({ title: "Idle child" })).id,
        token: claimed.token,
      }),
    );
    expect(linked.card).toMatchObject({ status: "todo" });

    await expect(
      mainTools.get("workboard_link")?.execute("call-5", {
        parentId: parent.id,
        childId: child.id,
        token: "child-token",
      }),
    ).rejects.toThrow(/active child/);
  });

  it("creates dependent cards and completes claimed work through tools", async () => {
    const keyed = createMemoryStore();
    const { api, run, bindSession } = createDispatchApi(keyed);
    const store = new WorkboardStore(keyed);
    const completeCard = vi.fn(
      async (...args: Parameters<WorkboardStore["complete"]>) => await store.complete(...args),
    );
    const tools = new Map(
      createWorkboardTools({
        api,
        store,
        completeCard,
        context: {
          agentId: "main",
          sessionKey: "agent:main:telegram:direct:requester",
          deliveryContext: { channel: "telegram", to: "requester" },
        } as never,
      }).map((tool) => [tool.name, tool]),
    );

    const parentPayload = readPayload(
      await tools.get("workboard_create")?.execute("call-1", {
        title: "Parent",
        status: "running",
      }),
    );
    const parent = parentPayload.card as { id: string };
    const childPayload = readPayload(
      await tools.get("workboard_create")?.execute("call-2", {
        title: "Child",
        parents: [parent.id],
        tenant: "qa",
        skills: ["testing"],
      }),
    );
    const child = childPayload.card as { id: string; status: string };
    expect(child.status).toBe("todo");

    await expect(
      tools.get("workboard_complete")?.execute("call-unclaimed-complete", {
        id: parent.id,
        summary: "Too early.",
      }),
    ).rejects.toThrow(/claimed/);
    await expect(
      tools.get("workboard_block")?.execute("call-unclaimed-block", {
        id: child.id,
        reason: "Too early.",
      }),
    ).rejects.toThrow(/claimed/);
    await expect(
      tools.get("workboard_protocol_violation")?.execute("call-unclaimed-violation", {
        id: child.id,
        detail: "Too early.",
      }),
    ).rejects.toThrow(/claimed/);

    const claimed = readPayload(
      await tools.get("workboard_claim")?.execute("call-3", { id: parent.id }),
    );
    const token = claimed.token as string;
    const completed = readPayload(
      await tools.get("workboard_complete")?.execute("call-4", {
        id: parent.id,
        token,
        summary: "Done.",
        createdCardIds: [child.id],
        proof: { status: "passed", command: "pnpm test extensions/workboard" },
      }),
    );
    expect(completed.card).toMatchObject({ status: "done" });
    expect(completeCard).toHaveBeenCalledWith(
      parent.id,
      expect.objectContaining({ summary: "Done." }),
      expect.objectContaining({ ownerId: "main", token }),
    );

    const dispatch = readPayload(await tools.get("workboard_dispatch")?.execute("call-5", {}));
    expect(dispatch.promoted).toEqual([expect.objectContaining({ id: child.id, status: "ready" })]);
    expect(dispatch.started).toEqual([
      expect.objectContaining({ cardId: child.id, runId: expect.any(String) }),
    ]);
    expect(run).toHaveBeenCalledOnce();
    expect(bindSession).toHaveBeenCalledWith({
      sessionKey: "agent:main:telegram:direct:requester",
      requesterOrigin: { channel: "telegram", to: "requester" },
    });
  });

  it("persists a fixed owner policy for cron-created work and resolves it at dispatch", async () => {
    const keyed = createMemoryStore();
    const { api, run, bindSession, resolveOwnerSession } = createDispatchApi(keyed);
    const store = new WorkboardStore(keyed);
    const tools = new Map(
      createWorkboardTools({
        api,
        store,
        context: {
          agentId: "main",
          sessionKey: "agent:main:cron:nightly:run:1",
          deliveryContext: { channel: "telegram", to: "cron-route" },
          workspaceDir: "/tmp/cron-workspace",
        } as never,
      }).map((tool) => [tool.name, tool]),
    );

    const createdPayload = readPayload(
      await tools.get("workboard_create")?.execute("call-create", {
        title: "Scheduled durable workflow",
        status: "scheduled",
        scheduledAt: 1,
      }),
    );
    const cardId = (createdPayload.card as { id: string }).id;
    await expect(store.get(cardId)).resolves.toMatchObject({
      metadata: {
        automation: { requesterOwnerMode: "canonical_main_no_origin" },
      },
    });
    const beforeDispatch = await store.get(cardId);
    expect(beforeDispatch?.metadata?.automation?.requesterSessionKey).toBeUndefined();
    expect(beforeDispatch?.metadata?.automation?.requesterOrigin).toBeUndefined();
    expect(beforeDispatch?.metadata?.automation?.requesterWorkspace).toBeUndefined();

    await tools.get("workboard_dispatch")?.execute("call-dispatch", {});

    const proposedWorker = `subagent:workboard-default-${cardId}`;
    expect(resolveOwnerSession).toHaveBeenCalledWith({ sessionKey: proposedWorker });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: `agent:main:${proposedWorker}`,
        flowOwnerSessionKey: "agent:main:main",
        cwd: "/tmp/canonical-worker-workspace",
      }),
    );
    expect(bindSession).toHaveBeenCalledWith({ sessionKey: "agent:main:main" });
    const running = await store.get(cardId);
    expect(running).toMatchObject({
      status: "running",
      metadata: {
        automation: {
          controllerId: "workboard",
          flowOwnerSessionKey: "agent:main:main",
          requesterWorkspace: "/tmp/canonical-worker-workspace",
        },
      },
    });
    expect(running?.metadata?.automation?.requesterOwnerMode).toBeUndefined();
  });

  it("redacts claim tokens from dispatch tool results", async () => {
    const keyed = createMemoryStore();
    const { api } = createDispatchApi(keyed);
    const store = new WorkboardStore(keyed);
    const tools = new Map(
      createWorkboardTools({
        api,
        store,
        context: {
          agentId: "main",
          sessionKey: "agent:main:telegram:direct:requester",
          deliveryContext: { channel: "telegram", to: "requester" },
        } as never,
      }).map((tool) => [tool.name, tool]),
    );
    const card = await store.create({
      title: "Scheduled",
      status: "scheduled",
      scheduledAt: 1,
    });
    await store.update(card.id, {
      metadata: {
        ...card.metadata,
        claim: {
          ownerId: "main",
          token: "secret-token",
          claimedAt: 1,
          lastHeartbeatAt: 1,
          expiresAt: Date.now() + 60_000,
        },
      },
    });

    const dispatch = readPayload(await tools.get("workboard_dispatch")?.execute("call-1", {}));

    const promoted = dispatch.promoted as Array<{
      metadata?: { claim?: { token?: string } };
    }>;
    expect(promoted).toEqual([expect.objectContaining({ id: card.id })]);
    expect(promoted[0]?.metadata?.claim?.token).toBe("[redacted]");
  });

  it("exposes board lifecycle, decomposition, runs, and notification tools", async () => {
    const keyed = createMemoryStore();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => keyed),
        },
      },
    } as unknown as OpenClawPluginApi;
    const store = new WorkboardStore(keyed);
    const tools = new Map(
      createWorkboardTools({
        api,
        store,
        context: { agentId: "main" } as never,
      }).map((tool) => [tool.name, tool]),
    );

    const boardPayload = readPayload(
      await tools.get("workboard_board_create")?.execute("call-board", {
        id: "planning",
        name: "Planning",
        orchestration: {
          autoDecompose: true,
          autoDecomposePerDispatch: 2,
          orchestratorProfile: "planner",
        },
      }),
    );
    expect(boardPayload.board).toMatchObject({
      id: "planning",
      name: "Planning",
      orchestration: {
        autoDecompose: true,
        autoDecomposePerDispatch: 2,
        orchestratorProfile: "planner",
      },
    });

    const parent = await store.create({
      title: "Rough",
      status: "triage",
      boardId: "planning",
      idempotencyKey: "planning:rough",
    });
    const specified = readPayload(
      await tools.get("workboard_specify")?.execute("call-specify", {
        id: parent.id,
        title: "Specified",
        summary: "Ready to split.",
      }),
    );
    expect(specified.card).toMatchObject({ title: "Specified", status: "todo" });

    const decomposed = readPayload(
      await tools.get("workboard_decompose")?.execute("call-decompose", {
        id: parent.id,
        summary: "Split.",
        children: [{ title: "Child A" }, { title: "Child B" }],
      }),
    );
    expect(decomposed.parent).toMatchObject({ status: "done" });
    expect(decomposed.children).toEqual([
      expect.objectContaining({ title: "Child A" }),
      expect.objectContaining({ title: "Child B" }),
    ]);

    const runs = readPayload(
      await tools.get("workboard_runs")?.execute("call-runs", { id: parent.id }),
    );
    expect(runs.attempts).toEqual([]);

    const subscription = readPayload(
      await tools.get("workboard_notify_subscribe")?.execute("call-subscribe", {
        boardId: "planning",
        cardId: parent.id,
        target: "session:operator",
        eventKinds: ["completed"],
      }),
    );
    expect(subscription.subscription).toMatchObject({
      boardId: "planning",
      cardId: parent.id,
      target: "session:operator",
      eventKinds: ["completed"],
    });

    const list = readPayload(
      await tools.get("workboard_notify_list")?.execute("call-notify-list", {
        boardId: "planning",
      }),
    );
    expect(list.subscriptions).toEqual([
      expect.objectContaining({ cardId: parent.id, target: "session:operator" }),
    ]);

    const events = readPayload(
      await tools.get("workboard_notify_advance")?.execute("call-notify-events", {
        subscriptionId: (subscription.subscription as { id: string }).id,
      }),
    );
    expect(events.events).toEqual([expect.objectContaining({ kind: "completed" })]);

    const attached = readPayload(
      await tools.get("workboard_attachment_add")?.execute("call-attach", {
        id: parent.id,
        fileName: "result.txt",
        contentBase64: Buffer.from("done").toString("base64"),
      }),
    );
    expect(attached.card).toMatchObject({
      metadata: { attachments: [expect.objectContaining({ fileName: "result.txt" })] },
    });
    const attachmentId = (attached.card as { metadata: { attachments: Array<{ id: string }> } })
      .metadata.attachments[0].id;
    const attachment = readPayload(
      await tools.get("workboard_attachment_read")?.execute("call-attachment-read", {
        id: attachmentId,
      }),
    );
    expect(Buffer.from(attachment.contentBase64 as string, "base64").toString("utf8")).toBe("done");
  });
});
