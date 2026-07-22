// Workboard tests cover command plugin behavior.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { handleWorkboardCommand, registerWorkboardCommand } from "./command.js";
import type { WorkboardSubagentRuntime, WorkboardWorktreeRuntime } from "./dispatcher.js";
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

function createApi(
  run = vi.fn(async (params: { idempotencyKey?: string }) => ({
    runId: params.idempotencyKey!,
  })),
): {
  runtime: {
    subagent: WorkboardSubagentRuntime;
    worktrees: WorkboardWorktreeRuntime;
    tasks: {
      managedFlows: OpenClawPluginApi["runtime"]["tasks"]["managedFlows"];
    };
  };
} {
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
  const managedFlows: OpenClawPluginApi["runtime"]["tasks"]["managedFlows"] = {
    bindSession:
      bindSession as unknown as OpenClawPluginApi["runtime"]["tasks"]["managedFlows"]["bindSession"],
    fromToolContext:
      vi.fn() as unknown as OpenClawPluginApi["runtime"]["tasks"]["managedFlows"]["fromToolContext"],
  };
  return {
    runtime: {
      subagent: {
        run,
      },
      tasks: { managedFlows },
      worktrees: {
        create: vi.fn(),
        release: vi.fn(),
        removeIfLossless: vi.fn(),
      },
    },
  };
}

async function createAmbiguousPrefix(store: WorkboardStore): Promise<string> {
  const seen = new Map<string, string>();
  for (let index = 0; index < 40; index += 1) {
    const card = await store.create({ title: `Card ${index}` });
    const prefix = card.id.slice(0, 1);
    if (seen.has(prefix)) {
      return prefix;
    }
    seen.set(prefix, card.id);
  }
  throw new Error("could not create cards with a shared prefix");
}

describe("handleWorkboardCommand", () => {
  it("preserves the host workspace for slash-created card completion artifacts", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const runtimeApi = createApi();
    const registerCommand = vi.fn();
    registerWorkboardCommand({
      api: {
        ...runtimeApi,
        registerCommand,
      } as unknown as OpenClawPluginApi,
      store,
    });
    const definition = registerCommand.mock.calls[0]?.[0] as
      | Parameters<OpenClawPluginApi["registerCommand"]>[0]
      | undefined;
    expect(definition).toBeDefined();
    const context = {
      args: "create Slash completion",
      senderIsOwner: true,
      sessionKey: "agent:main:telegram:direct:requester",
      workspaceDir: "/workspace/requester",
      channel: "telegram",
      from: "telegram:group:-100123",
      to: "telegram:bot:main",
      isAuthorizedSender: true,
      commandBody: "/workboard create Slash completion",
      config: {},
    } as unknown as Parameters<NonNullable<typeof definition>["handler"]>[0];

    await definition!.handler(context);
    const card = (await store.list())[0];
    expect(card.metadata?.automation).toMatchObject({
      requesterOrigin: { channel: "telegram", to: "telegram:group:-100123" },
      requesterWorkspace: "/workspace/requester",
    });
    await store.update(card.id, { status: "ready" });
    await definition!.handler({
      ...context,
      args: "dispatch",
      commandBody: "/workboard dispatch",
    });

    await expect(store.get(card.id)).resolves.toMatchObject({
      metadata: { automation: { requesterWorkspace: "/workspace/requester" } },
    });
    expect(runtimeApi.runtime.subagent.run).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/workspace/requester" }),
    );
    expect(runtimeApi.runtime.tasks.managedFlows.bindSession).toHaveBeenCalledWith({
      sessionKey: "agent:main:telegram:direct:requester",
      requesterOrigin: { channel: "telegram", to: "telegram:group:-100123" },
    });
  });

  it("creates, lists, and dispatches workboard cards", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const api = createApi();

    await expect(
      handleWorkboardCommand({
        api,
        store,
        args: "create Ship CLI",
        senderIsOwner: true,
        requesterSessionKey: "agent:main:telegram:direct:requester",
        requesterOrigin: { channel: "telegram", to: "requester" },
      }),
    ).resolves.toEqual(expect.objectContaining({ text: expect.stringContaining("Ship CLI") }));
    const card = (await store.list())[0];
    expect(card).toMatchObject({ title: "Ship CLI" });

    await expect(handleWorkboardCommand({ api, store, args: "list" })).resolves.toEqual(
      expect.objectContaining({ text: expect.stringContaining("Ship CLI") }),
    );
    await store.update(card.id, { status: "ready" });
    await expect(
      handleWorkboardCommand({
        api,
        store,
        args: "dispatch",
        gatewayClientScopes: ["operator.write"],
      }),
    ).resolves.toEqual(expect.objectContaining({ text: expect.stringContaining("started=1") }));
    expect(api.runtime.subagent.run).toHaveBeenCalledOnce();
    expect(api.runtime.tasks.managedFlows.bindSession).toHaveBeenCalledWith({
      sessionKey: "agent:main:telegram:direct:requester",
      requesterOrigin: { channel: "telegram", to: "requester" },
    });
  });

  it("requires write access for slash mutations", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const api = createApi();
    const card = await store.create({ title: "Ready worker", status: "ready" });

    await expect(handleWorkboardCommand({ api, store, args: "list" })).resolves.toEqual(
      expect.objectContaining({ text: expect.stringContaining("Ready worker") }),
    );
    await expect(handleWorkboardCommand({ api, store, args: "create Blocked" })).resolves.toEqual(
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("operator.write"),
      }),
    );
    await expect(handleWorkboardCommand({ api, store, args: "dispatch" })).resolves.toEqual(
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("operator.write"),
      }),
    );
    expect(api.runtime.subagent.run).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("wakes reconciliation when a dispatch response is ambiguous", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const run = vi.fn().mockRejectedValue(new Error("response lost after acceptance"));
    const api = createApi(run);
    const onReconciliationNeeded = vi.fn();
    const card = await store.create({
      title: "Ambiguous command start",
      status: "ready",
      requesterSessionKey: "agent:main:telegram:direct:requester",
      requesterOrigin: { channel: "telegram", to: "requester" },
    });

    await handleWorkboardCommand({
      api,
      store,
      args: "dispatch",
      gatewayClientScopes: ["operator.write"],
      onReconciliationNeeded,
    });

    expect(onReconciliationNeeded).toHaveBeenCalledOnce();
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      metadata: {
        claim: expect.objectContaining({ token: expect.any(String) }),
        automation: { startIdempotencyKey: expect.any(String) },
      },
    });
  });

  it("requires admin scope for slash-command worktree materialization", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const api = createApi();
    const createWorktree = vi.mocked(api.runtime.worktrees.create);
    createWorktree.mockResolvedValue({
      id: "managed-id",
      path: "/state/worktrees/fingerprint/wb-card",
      branch: "openclaw/wb-card",
    });
    await store.create({
      title: "Denied checkout",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo-denied" },
      requesterSessionKey: "agent:main:telegram:direct:requester",
      requesterOrigin: { channel: "telegram", to: "requester" },
    });

    await expect(
      handleWorkboardCommand({
        api,
        store,
        args: "dispatch",
        gatewayClientScopes: ["operator.write"],
      }),
    ).resolves.toEqual(
      expect.objectContaining({ text: expect.stringContaining("operator.admin") }),
    );
    expect(createWorktree).not.toHaveBeenCalled();
    const denied = (await store.list()).find((card) => card.title === "Denied checkout");
    expect(denied).toMatchObject({ status: "ready" });
    await store.update(denied!.id, { status: "blocked" });

    const allowed = await store.create({
      title: "Allowed checkout",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo-allowed" },
      requesterSessionKey: "agent:main:telegram:direct:requester",
      requesterOrigin: { channel: "telegram", to: "requester" },
    });
    await handleWorkboardCommand({
      api,
      store,
      args: "dispatch",
      gatewayClientScopes: ["operator.admin"],
    });

    expect(createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: "/repo-allowed", ownerId: allowed.id }),
    );
  });

  it("rejects ambiguous card id prefixes", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const api = createApi();
    const prefix = await createAmbiguousPrefix(store);

    await expect(handleWorkboardCommand({ api, store, args: `show ${prefix}` })).resolves.toEqual(
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("Ambiguous card id prefix"),
      }),
    );
  });
});
