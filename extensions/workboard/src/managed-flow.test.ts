import { describe, expect, it, vi } from "vitest";
import { ensureWorkboardManagedFlow } from "./managed-flow.js";
import { WorkboardStore, type PersistedWorkboardCard, type WorkboardKeyedStore } from "./store.js";

const REQUESTER_SESSION_KEY = "agent:main:telegram:direct:requester";
const REQUESTER_ORIGIN = {
  channel: "telegram",
  to: "requester",
  accountId: "default",
};
const WORKER_SESSION_KEY = "agent:main:subagent:workboard-crash-window";

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

describe("Workboard managed TaskFlow", () => {
  it("uses the initiating conversation as owner and reuses its exact projected flow", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Crash-window flow",
      status: "ready",
      idempotencyKey: "crash-window-flow",
      requesterSessionKey: REQUESTER_SESSION_KEY,
      requesterOrigin: REQUESTER_ORIGIN,
    });
    const flows: Array<Record<string, unknown>> = [];
    const createManaged = vi.fn((input: Record<string, unknown>) => {
      const flow = {
        ...input,
        flowId: "flow-crash-window",
        syncMode: "managed",
        ownerKey: REQUESTER_SESSION_KEY,
        requesterOrigin: REQUESTER_ORIGIN,
        revision: 1,
      };
      flows.push(flow);
      return flow;
    });
    const bound = {
      sessionKey: REQUESTER_SESSION_KEY,
      createManaged,
      list: vi.fn(() => flows),
      get: vi.fn((flowId: string) => flows.find((flow) => flow.flowId === flowId)),
    };
    const managedFlows = { bindSession: vi.fn(() => bound) };

    const first = await ensureWorkboardManagedFlow({
      store,
      card,
      workerSessionKey: WORKER_SESSION_KEY,
      managedFlows: managedFlows as never,
      now: 10,
    });
    const eventCountAfterProjection = first.card.events?.length;
    const second = await ensureWorkboardManagedFlow({
      store,
      card: first.card,
      workerSessionKey: WORKER_SESSION_KEY,
      managedFlows: managedFlows as never,
      now: 20,
    });

    expect(managedFlows.bindSession).toHaveBeenCalledWith({
      sessionKey: REQUESTER_SESSION_KEY,
      requesterOrigin: REQUESTER_ORIGIN,
    });
    expect(createManaged).toHaveBeenCalledOnce();
    expect(second.context.flow.flowId).toBe(first.context.flow.flowId);
    expect(second.context.ownerSessionKey).toBe(REQUESTER_SESSION_KEY);
    expect(second.card.events).toHaveLength(eventCountAfterProjection ?? 0);
    expect(second.card.metadata?.automation).not.toHaveProperty("requesterSessionKey");
    expect(second.card.metadata?.automation).not.toHaveProperty("requesterOrigin");
  });

  it("recovers the exact flow after a crash between flow persistence and card projection", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Flow before projection",
      status: "ready",
      idempotencyKey: "flow-before-projection",
      requesterSessionKey: REQUESTER_SESSION_KEY,
      requesterOrigin: REQUESTER_ORIGIN,
    });
    const flows: Array<Record<string, unknown>> = [];
    const createManaged = vi.fn((input: Record<string, unknown>) => {
      const flow = {
        ...input,
        flowId: "flow-before-card-cas",
        syncMode: "managed",
        ownerKey: REQUESTER_SESSION_KEY,
        requesterOrigin: REQUESTER_ORIGIN,
        revision: 1,
      };
      flows.push(flow);
      return flow;
    });
    const managedFlows = {
      bindSession: vi.fn(() => ({
        sessionKey: REQUESTER_SESSION_KEY,
        createManaged,
        list: vi.fn(() => flows),
        get: vi.fn((flowId: string) => flows.find((flow) => flow.flowId === flowId)),
      })),
    };
    vi.spyOn(store, "projectManagedFlow").mockRejectedValueOnce(
      new Error("crash after flow commit"),
    );

    await expect(
      ensureWorkboardManagedFlow({
        store,
        card,
        workerSessionKey: "agent:main:subagent:flow-before-projection",
        managedFlows: managedFlows as never,
        now: 10,
      }),
    ).rejects.toThrow("crash after flow commit");
    const recovered = await ensureWorkboardManagedFlow({
      store,
      card,
      workerSessionKey: "agent:main:subagent:flow-before-projection",
      managedFlows: managedFlows as never,
      now: 20,
    });

    expect(createManaged).toHaveBeenCalledOnce();
    expect(flows).toHaveLength(1);
    expect(recovered.context.flow.flowId).toBe("flow-before-card-cas");
    expect(recovered.card.metadata?.automation).toMatchObject({
      flowId: "flow-before-card-cas",
      flowOwnerSessionKey: REQUESTER_SESSION_KEY,
      controllerId: "workboard",
    });
    expect(recovered.card.metadata?.automation).not.toHaveProperty("requesterSessionKey");
    expect(recovered.card.metadata?.automation).not.toHaveProperty("requesterOrigin");
  });

  it("rejects a subagent or cross-agent session as the managed flow owner", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const baseCard = {
      title: "Invalid flow owner",
      status: "ready" as const,
      idempotencyKey: "invalid-flow-owner",
      requesterOrigin: REQUESTER_ORIGIN,
    };
    const subagentOwnerCard = await store.create({
      ...baseCard,
      requesterSessionKey: "agent:main:subagent:requester",
    });
    const crossAgentCard = await store.create({
      ...baseCard,
      idempotencyKey: "invalid-flow-owner-cross-agent",
      requesterSessionKey: "agent:other:telegram:direct:requester",
    });
    const managedFlows = { bindSession: vi.fn() };

    await expect(
      ensureWorkboardManagedFlow({
        store,
        card: subagentOwnerCard,
        workerSessionKey: "agent:main:subagent:workboard-invalid-owner",
        managedFlows: managedFlows as never,
      }),
    ).rejects.toThrow("initiating non-subagent session");
    await expect(
      ensureWorkboardManagedFlow({
        store,
        card: crossAgentCard,
        workerSessionKey: "agent:main:subagent:workboard-invalid-owner",
        managedFlows: managedFlows as never,
      }),
    ).rejects.toThrow("same agent");
    expect(managedFlows.bindSession).not.toHaveBeenCalled();
  });
});
