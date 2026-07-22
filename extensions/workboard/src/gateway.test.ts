// Workboard tests cover gateway plugin behavior.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { registerWorkboardGatewayMethods } from "./gateway.js";
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

function createManagedFlowRuntime() {
  const flows = new Map<string, Record<string, unknown>>();
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
    }),
  );
  return {
    bindSession,
    managedFlows: { bindSession },
    resolveOwnerSession: vi.fn(async ({ sessionKey }: { sessionKey: string }) => ({
      status: "resolved" as const,
      workerSessionKey: sessionKey.startsWith("agent:") ? sessionKey : `agent:main:${sessionKey}`,
      ownerSessionKey: "agent:main:main",
      workspaceDir: "/tmp/canonical-worker-workspace",
    })),
  };
}

describe("workboard gateway methods", () => {
  it("registers CRUD methods with read/write scopes", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({ api, store: new WorkboardStore(createMemoryStore()) });

    expect([...methods.keys()]).toEqual([
      "workboard.cards.list",
      "workboard.cards.create",
      "workboard.cards.update",
      "workboard.cards.move",
      "workboard.cards.delete",
      "workboard.cards.comment",
      "workboard.cards.link",
      "workboard.cards.linkDependency",
      "workboard.cards.proof",
      "workboard.cards.artifact",
      "workboard.cards.claim",
      "workboard.cards.heartbeat",
      "workboard.cards.release",
      "workboard.cards.promote",
      "workboard.cards.reassign",
      "workboard.cards.reclaim",
      "workboard.cards.complete",
      "workboard.cards.block",
      "workboard.cards.unblock",
      "workboard.cards.bulk",
      "workboard.cards.diagnostics",
      "workboard.cards.diagnostics.refresh",
      "workboard.cards.dispatch",
      "workboard.boards.list",
      "workboard.boards.upsert",
      "workboard.boards.archive",
      "workboard.boards.delete",
      "workboard.cards.stats",
      "workboard.cards.runs",
      "workboard.cards.specify",
      "workboard.cards.decompose",
      "workboard.notifications.subscribe",
      "workboard.notifications.list",
      "workboard.notifications.delete",
      "workboard.notifications.events",
      "workboard.notifications.advance",
      "workboard.cards.attachments.list",
      "workboard.cards.attachments.get",
      "workboard.cards.attachments.add",
      "workboard.cards.attachments.delete",
      "workboard.cards.workerLog",
      "workboard.cards.protocolViolation",
      "workboard.cards.archive",
      "workboard.cards.export",
    ]);
    expect(methods.get("workboard.cards.list")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("workboard.cards.diagnostics")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("workboard.cards.diagnostics.refresh")?.opts).toEqual({
      scope: "operator.write",
    });
    expect(methods.get("workboard.cards.export")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("workboard.cards.create")?.opts).toEqual({ scope: "operator.write" });
    expect(methods.get("workboard.cards.runs")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("workboard.cards.attachments.get")?.opts).toEqual({
      scope: "operator.read",
    });
    expect(methods.get("workboard.cards.attachments.add")?.opts).toEqual({
      scope: "operator.write",
    });
    expect(methods.get("workboard.boards.upsert")?.opts).toEqual({ scope: "operator.write" });
    expect(methods.get("workboard.notifications.list")?.opts).toEqual({
      scope: "operator.read",
    });
    expect(methods.get("workboard.notifications.events")?.opts).toEqual({
      scope: "operator.read",
    });
    expect(methods.get("workboard.notifications.advance")?.opts).toEqual({
      scope: "operator.write",
    });

    const createHandler = methods.get("workboard.cards.create")?.handler;
    const listHandler = methods.get("workboard.cards.list")?.handler;
    const createRespond = vi.fn();
    await createHandler?.({
      params: { title: "Investigate queue drift", priority: "urgent" },
      respond: createRespond,
    } as never);
    expect(createRespond.mock.calls[0]?.[0]).toBe(true);
    const cardId = createRespond.mock.calls[0]?.[1]?.card.id;

    for (const [method, requestParams] of [
      [
        "workboard.cards.create",
        {
          title: "Hijack route",
          requesterOrigin: { channel: "telegram", to: "attacker" },
        },
      ],
      [
        "workboard.cards.update",
        {
          id: cardId,
          patch: { metadata: { automation: { flowOwnerSessionKey: "agent:other:main" } } },
        },
      ],
      [
        "workboard.cards.bulk",
        { ids: [cardId], patch: { metadata: { automation: { controllerId: "attacker" } } } },
      ],
      [
        "workboard.cards.create",
        { title: "Inject scheduled policy", requesterOwnerMode: "canonical_main_no_origin" },
      ],
    ] as const) {
      const hijackRespond = vi.fn();
      await methods
        .get(method)
        ?.handler({ params: requestParams, respond: hijackRespond } as never);
      expect(hijackRespond.mock.calls[0]?.[0]).toBe(false);
      expect(hijackRespond.mock.calls[0]?.[2]?.message).toContain("reserved");
    }

    const listRespond = vi.fn();
    await listHandler?.({ params: {}, respond: listRespond } as never);
    expect(listRespond.mock.calls[0]?.[1]).toMatchObject({
      cards: [expect.objectContaining({ title: "Investigate queue drift" })],
    });

    const eventsRespond = vi.fn();
    await methods.get("workboard.notifications.events")?.handler({
      params: { advance: true },
      respond: eventsRespond,
    } as never);
    expect(eventsRespond.mock.calls[0]?.[0]).toBe(false);
    expect(eventsRespond.mock.calls[0]?.[2]?.message).toContain("workboard.notifications.advance");
  });

  it("stores metadata updates through dedicated card methods", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({ api, store: new WorkboardStore(createMemoryStore()) });

    const createRespond = vi.fn();
    await methods.get("workboard.cards.create")?.handler({
      params: { title: "Carry metadata" },
      respond: createRespond,
    } as never);
    const cardId = createRespond.mock.calls[0]?.[1]?.card.id;

    const commentRespond = vi.fn();
    await methods.get("workboard.cards.comment")?.handler({
      params: { id: cardId, body: "Waiting on CI" },
      respond: commentRespond,
    } as never);

    expect(commentRespond.mock.calls[0]?.[0]).toBe(true);
    expect(commentRespond.mock.calls[0]?.[1]).toMatchObject({
      card: {
        metadata: {
          comments: [expect.objectContaining({ body: "Waiting on CI" })],
        },
        events: expect.arrayContaining([expect.objectContaining({ kind: "comment_added" })]),
      },
    });
  });

  it("validates labels from comma-separated gateway input", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({ api, store: new WorkboardStore(createMemoryStore()) });

    const createHandler = methods.get("workboard.cards.create")?.handler;
    const respond = vi.fn();
    await createHandler?.({
      params: { title: "Check labels", labels: `valid, ${"x".repeat(41)}` },
      respond,
    } as never);

    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[2]).toMatchObject({
      message: "labels must be 40 characters or fewer.",
    });
  });

  it("keeps a bound chat route when a client also requests canonical owner mode", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const run = vi.fn(async (params: { idempotencyKey?: string }) => ({
      runId: params.idempotencyKey!,
    }));
    const flowRuntime = createManagedFlowRuntime();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
        subagent: { run, resolveOwnerSession: flowRuntime.resolveOwnerSession },
        tasks: { managedFlows: flowRuntime.managedFlows },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Ready worker",
      status: "ready",
      priority: "urgent",
      requesterSessionKey: "agent:main:telegram:direct:requester",
      requesterOrigin: { channel: "telegram", to: "requester" },
    });

    registerWorkboardGatewayMethods({ api, store });

    const respond = vi.fn();
    await methods.get("workboard.cards.dispatch")?.handler({
      params: { ownerMode: "canonical_main_no_origin" },
      respond,
    } as never);

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      started: [
        expect.objectContaining({
          cardId: card.id,
          runId: run.mock.calls[0]?.[0].idempotencyKey,
        }),
      ],
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: `agent:main:subagent:workboard-default-${card.id}`,
      }),
    );
    expect(flowRuntime.bindSession).toHaveBeenCalledWith({
      sessionKey: "agent:main:telegram:direct:requester",
      requesterOrigin: { channel: "telegram", to: "requester" },
    });
    expect(flowRuntime.resolveOwnerSession).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      agentId: "main",
      metadata: { claim: { ownerId: "main" } },
    });
  });

  it("resolves a fixed canonical owner for a route-less write-scoped dashboard dispatch", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const run = vi.fn(async (params: { idempotencyKey?: string }) => ({
      runId: params.idempotencyKey!,
    }));
    const flowRuntime = createManagedFlowRuntime();
    const resolveOwnerSession = vi.fn(async ({ sessionKey }: { sessionKey: string }) => ({
      status: "resolved" as const,
      workerSessionKey: `agent:main:${sessionKey}`,
      ownerSessionKey: "global",
      workspaceDir: "/tmp/dashboard-worker-workspace",
    }));
    const api = {
      runtime: {
        subagent: { run, resolveOwnerSession },
        tasks: { managedFlows: flowRuntime.managedFlows },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Route-less dashboard card", status: "ready" });
    registerWorkboardGatewayMethods({ api, store });

    const invalidRespond = vi.fn();
    await methods.get("workboard.cards.dispatch")?.handler({
      params: { ownerMode: "caller_supplied_route" },
      client: { connect: { scopes: ["operator.write"] } },
      respond: invalidRespond,
    } as never);
    expect(invalidRespond.mock.calls[0]?.[0]).toBe(false);
    expect(invalidRespond.mock.calls[0]?.[2]?.message).toContain("unsupported");
    expect(resolveOwnerSession).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();

    const respond = vi.fn();
    await methods.get("workboard.cards.dispatch")?.handler({
      params: { ownerMode: "canonical_main_no_origin" },
      client: { connect: { scopes: ["operator.write"] } },
      respond,
    } as never);

    const proposedWorker = `subagent:workboard-default-${card.id}`;
    expect(resolveOwnerSession).toHaveBeenCalledWith({ sessionKey: proposedWorker });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: `agent:main:${proposedWorker}`,
        flowOwnerSessionKey: "global",
        cwd: "/tmp/dashboard-worker-workspace",
      }),
    );
    expect(flowRuntime.bindSession).toHaveBeenCalledWith({ sessionKey: "global" });
    await expect(store.get(card.id)).resolves.toMatchObject({
      metadata: {
        automation: { requesterWorkspace: "/tmp/dashboard-worker-workspace" },
      },
    });
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      started: [expect.objectContaining({ cardId: card.id })],
    });
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      agentId: "main",
      sessionKey: `agent:main:${proposedWorker}`,
      metadata: {
        claim: { ownerId: "main" },
        automation: {
          flowOwnerSessionKey: "global",
          controllerId: "workboard",
        },
      },
    });
  });

  it("rejects generic lifecycle mutations and deletion for an active managed card", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const api = {
      runtime: { subagent: {}, tasks: { managedFlows: {} } },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;
    const store = new WorkboardStore(createMemoryStore());
    const requesterSessionKey = "agent:main:main";
    const card = await store.create({
      title: "Managed lifecycle",
      status: "ready",
      requesterSessionKey,
    });
    await store.projectManagedFlow(card.id, {
      flowId: "flow-active",
      flowOwnerSessionKey: requesterSessionKey,
      flowRevision: 1,
      controllerId: "workboard",
      clearRequesterRoute: true,
    });
    registerWorkboardGatewayMethods({ api, store });

    for (const [method, requestParams] of [
      ["workboard.cards.update", { id: card.id, patch: { status: "done" } }],
      [
        "workboard.cards.update",
        { id: card.id, patch: { sessionKey: "agent:other:subagent:hijack", runId: "bad" } },
      ],
      ["workboard.cards.move", { id: card.id, status: "done", position: card.position }],
      ["workboard.cards.bulk", { ids: [card.id], patch: { status: "done" } }],
      ["workboard.cards.bulk", { ids: [card.id], patch: { agentId: "other" } }],
      ["workboard.cards.release", { id: card.id, status: "ready" }],
      ["workboard.cards.promote", { id: card.id }],
      ["workboard.cards.reassign", { id: card.id, agentId: "other" }],
      ["workboard.cards.reclaim", { id: card.id, reason: "replace worker" }],
      ["workboard.cards.block", { id: card.id, reason: "override worker" }],
      ["workboard.cards.archive", { id: card.id, archived: true }],
      ["workboard.cards.delete", { id: card.id }],
    ] as const) {
      const respond = vi.fn();
      await methods.get(method)?.handler({ params: requestParams, respond } as never);
      expect(respond.mock.calls[0]?.[0]).toBe(false);
    }
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("fails closed per card when a route-less gateway dispatch omits owner mode", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const run = vi.fn();
    const flowRuntime = createManagedFlowRuntime();
    const api = {
      runtime: {
        subagent: { run, resolveOwnerSession: flowRuntime.resolveOwnerSession },
        tasks: { managedFlows: flowRuntime.managedFlows },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "No implicit owner", status: "ready" });
    registerWorkboardGatewayMethods({ api, store });

    const respond = vi.fn();
    await methods.get("workboard.cards.dispatch")?.handler({
      params: {},
      client: { connect: { scopes: ["operator.write"] } },
      respond,
    } as never);

    expect(run).not.toHaveBeenCalled();
    expect(flowRuntime.resolveOwnerSession).not.toHaveBeenCalled();
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      startFailures: [
        expect.objectContaining({
          cardId: card.id,
          error: "managed Workboard TaskFlow requires an exact initiating requester session",
        }),
      ],
    });
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("requires admin scope for managed-worktree dispatch", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const run = vi.fn(async (params: { idempotencyKey?: string }) => ({
      runId: params.idempotencyKey!,
    }));
    const flowRuntime = createManagedFlowRuntime();
    const createWorktree = vi.fn().mockResolvedValue({
      id: "managed-id",
      path: "/state/worktrees/fingerprint/wb-card",
      branch: "openclaw/wb-card",
    });
    const api = {
      runtime: {
        subagent: { run, resolveOwnerSession: flowRuntime.resolveOwnerSession },
        tasks: { managedFlows: flowRuntime.managedFlows },
        worktrees: {
          create: createWorktree,
          release: vi.fn(),
          removeIfLossless: vi.fn(),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;
    const store = new WorkboardStore(createMemoryStore());
    const denied = await store.create({
      title: "Denied checkout",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo-denied" },
      requesterSessionKey: "agent:main:telegram:direct:requester",
      requesterOrigin: { channel: "telegram", to: "requester" },
    });
    registerWorkboardGatewayMethods({ api, store });
    const handler = methods.get("workboard.cards.dispatch")?.handler;

    const deniedRespond = vi.fn();
    await handler?.({
      client: { connect: { scopes: ["operator.write"] } },
      respond: deniedRespond,
    } as never);

    expect(createWorktree).not.toHaveBeenCalled();
    expect(deniedRespond.mock.calls[0]?.[1]).toMatchObject({
      startFailures: [
        expect.objectContaining({
          cardId: denied.id,
          error: "managed worktree dispatch requires operator.admin",
        }),
      ],
    });
    await expect(store.get(denied.id)).resolves.toMatchObject({ status: "ready" });
    await store.update(denied.id, { status: "blocked" });

    const allowed = await store.create({
      title: "Allowed checkout",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo-allowed" },
      requesterSessionKey: "agent:main:telegram:direct:requester",
      requesterOrigin: { channel: "telegram", to: "requester" },
    });
    await handler?.({
      client: { connect: { scopes: ["operator.admin"] } },
      respond: vi.fn(),
    } as never);

    expect(createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: "/repo-allowed", ownerId: allowed.id }),
    );
    expect(run).toHaveBeenCalledOnce();
  });

  it("claims, heartbeats, and bulk-updates cards through gateway methods", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    const store = new WorkboardStore(createMemoryStore());
    const completeCard = vi.fn(
      async (...args: Parameters<WorkboardStore["complete"]>) => await store.complete(...args),
    );
    registerWorkboardGatewayMethods({ api, store, completeCard });

    const createRespond = vi.fn();
    await methods.get("workboard.cards.create")?.handler({
      params: { title: "Claim me" },
      respond: createRespond,
    } as never);
    const cardId = createRespond.mock.calls[0]?.[1]?.card.id;

    const claimRespond = vi.fn();
    await methods.get("workboard.cards.claim")?.handler({
      params: { id: cardId, ownerId: "main" },
      respond: claimRespond,
    } as never);
    expect(claimRespond.mock.calls[0]?.[1]).toMatchObject({
      card: { status: "running", metadata: { claim: { ownerId: "main" } } },
      token: expect.any(String),
    });

    const heartbeatRespond = vi.fn();
    await methods.get("workboard.cards.heartbeat")?.handler({
      params: { id: cardId, ownerId: "main", note: "alive" },
      respond: heartbeatRespond,
    } as never);
    expect(heartbeatRespond.mock.calls[0]?.[1]).toMatchObject({
      card: { metadata: { comments: [expect.objectContaining({ body: "alive" })] } },
    });

    const bulkRespond = vi.fn();
    await methods.get("workboard.cards.bulk")?.handler({
      params: { ids: [cardId], patch: { priority: "urgent" } },
      respond: bulkRespond,
    } as never);
    expect(bulkRespond.mock.calls[0]?.[1]).toMatchObject({
      cards: [expect.objectContaining({ priority: "urgent" })],
    });

    const completeRespond = vi.fn();
    await methods.get("workboard.cards.complete")?.handler({
      params: { id: cardId, summary: "Operator closed it." },
      respond: completeRespond,
    } as never);
    expect(completeRespond.mock.calls[0]?.[1]).toMatchObject({
      card: {
        status: "done",
        metadata: {
          comments: expect.arrayContaining([
            expect.objectContaining({ body: "Operator closed it." }),
          ]),
        },
      },
    });
    expect(completeCard).toHaveBeenCalledWith(
      cardId,
      expect.objectContaining({ summary: "Operator closed it." }),
      null,
    );

    const blockedCreateRespond = vi.fn();
    await methods.get("workboard.cards.create")?.handler({
      params: { title: "Block me" },
      respond: blockedCreateRespond,
    } as never);
    const blockedCardId = blockedCreateRespond.mock.calls[0]?.[1]?.card.id;
    await methods.get("workboard.cards.claim")?.handler({
      params: { id: blockedCardId, ownerId: "main" },
      respond: vi.fn(),
    } as never);
    const blockRespond = vi.fn();
    await methods.get("workboard.cards.block")?.handler({
      params: { id: blockedCardId, reason: "Operator blocked it." },
      respond: blockRespond,
    } as never);
    expect(blockRespond.mock.calls[0]?.[1]).toMatchObject({
      card: { status: "blocked" },
    });
  });
});
