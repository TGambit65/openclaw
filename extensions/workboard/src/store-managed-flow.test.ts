import { describe, expect, it } from "vitest";
import { WorkboardStore, type PersistedWorkboardCard, type WorkboardKeyedStore } from "./store.js";

function createSharedStore(): WorkboardKeyedStore {
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

describe("Workboard managed-flow CAS projections", () => {
  it("binds one exact requester before flow creation and rejects a conflicting route", async () => {
    const store = new WorkboardStore(createSharedStore());
    const card = await store.create({ title: "Route-bound work", status: "ready" });
    const route = {
      requesterSessionKey: "agent:main:telegram:direct:123",
      requesterOrigin: { channel: "telegram", to: "123", accountId: "default" },
      requesterWorkspace: "/workspace/requester",
    };

    const bound = await store.bindManagedFlowRequester(card.id, route);
    const revision = bound.events?.at(-1)?.id;
    const replay = await store.bindManagedFlowRequester(card.id, route);

    expect(replay.events?.at(-1)?.id).toBe(revision);
    await expect(
      store.bindManagedFlowRequester(card.id, {
        ...route,
        requesterSessionKey: "agent:main:telegram:direct:different",
      }),
    ).rejects.toThrow("requester binding conflicts");
  });

  it("retries a stale projection, preserves concurrent metadata, and clears transient route", async () => {
    const keyed = createSharedStore();
    const first = new WorkboardStore(keyed);
    const second = new WorkboardStore(keyed);
    const card = await first.create({ title: "CAS-projected flow", status: "ready" });
    const requesterSessionKey = "agent:main:telegram:direct:123";
    await first.bindManagedFlowRequester(card.id, {
      requesterSessionKey,
      requesterOrigin: { channel: "telegram", to: "123" },
    });

    const originalCompareAndSwap = keyed.compareAndSwap!.bind(keyed);
    let injectConcurrentWrite = true;
    keyed.compareAndSwap = async (key, value, options) => {
      if (injectConcurrentWrite) {
        injectConcurrentWrite = false;
        await second.addComment(card.id, { body: "concurrent metadata survives" });
        return "stale";
      }
      return await originalCompareAndSwap(key, value, options);
    };

    const projected = await first.projectManagedFlow(card.id, {
      flowId: "flow-1",
      flowOwnerSessionKey: requesterSessionKey,
      flowRevision: 3,
      controllerId: "workboard",
      expectedRequesterSessionKey: requesterSessionKey,
      clearRequesterRoute: true,
    });

    expect(projected.metadata?.comments).toEqual([
      expect.objectContaining({ body: "concurrent metadata survives" }),
    ]);
    expect(projected.metadata?.automation).toMatchObject({
      flowId: "flow-1",
      flowOwnerSessionKey: requesterSessionKey,
      flowRevision: 3,
      controllerId: "workboard",
    });
    expect(projected.metadata?.automation?.requesterSessionKey).toBeUndefined();
    expect(projected.metadata?.automation?.requesterOrigin).toBeUndefined();
    await expect(
      first.projectManagedFlow(card.id, {
        flowId: "different-flow",
        flowOwnerSessionKey: requesterSessionKey,
        flowRevision: 1,
        controllerId: "workboard",
      }),
    ).rejects.toThrow("different managed flow");
  });

  it("blocks public status changes and deletion while a managed flow is active", async () => {
    const store = new WorkboardStore(createSharedStore());
    const requesterSessionKey = "agent:main:main";
    const card = await store.create({
      title: "Controller-owned lifecycle",
      status: "ready",
      requesterSessionKey,
    });
    await store.projectManagedFlow(card.id, {
      flowId: "flow-active",
      flowOwnerSessionKey: requesterSessionKey,
      flowRevision: 1,
      controllerId: "workboard",
      expectedRequesterSessionKey: requesterSessionKey,
      clearRequesterRoute: true,
    });

    await expect(store.update(card.id, { status: "done" })).rejects.toThrow(
      "trusted workflow controller",
    );
    await expect(store.move(card.id, "blocked", card.position)).rejects.toThrow(
      "trusted workflow controller",
    );
    await expect(store.bulkUpdate({ ids: [card.id], patch: { status: "done" } })).rejects.toThrow(
      "trusted workflow controller",
    );
    await expect(
      store.update(card.id, { sessionKey: "agent:other:subagent:hijack" }),
    ).rejects.toThrow("execution identity changes");
    await expect(store.bulkUpdate({ ids: [card.id], patch: { agentId: "other" } })).rejects.toThrow(
      "execution identity changes",
    );
    await expect(
      store.update(card.id, { title: "Safe title edit", position: 2_000 }),
    ).resolves.toMatchObject({ title: "Safe title edit", position: 2_000 });
    await expect(store.releaseClaim(card.id, { status: "ready" })).rejects.toThrow(
      "trusted workflow controller",
    );
    await expect(store.promote(card.id)).rejects.toThrow("trusted workflow controller");
    await expect(store.reassign(card.id, { agentId: "other" })).rejects.toThrow(
      "trusted workflow controller",
    );
    await expect(store.reclaim(card.id, { reason: "replace worker" }, null)).rejects.toThrow(
      "trusted workflow controller",
    );
    await expect(store.archive(card.id, true)).rejects.toThrow("trusted workflow controller");
    await expect(store.archive(card.id, false)).resolves.toMatchObject({ id: card.id });
    await expect(store.delete(card.id)).rejects.toThrow("delivery and cleanup complete");
    await expect(store.get(card.id)).resolves.toBeDefined();
  });

  it("requires post-delivery cleanup before deleting a managed card", async () => {
    const store = new WorkboardStore(createSharedStore());
    const completionDelivery = {
      kind: "verified_workboard_completion" as const,
      obligationId: "obligation-1",
      cardId: "card-projection",
      sessionKey: "agent:main:subagent:worker",
      runId: "run-1",
      payloadHash: "sha256",
      acceptedAt: 10,
      status: "delivered" as const,
      deliveredAt: 20,
    };
    const card = await store.create({
      title: "Delivered but not cleaned",
      status: "done",
      metadata: {
        automation: {
          flowId: "flow-delivered",
          flowOwnerSessionKey: "agent:main:main",
          flowRevision: 2,
          controllerId: "workboard",
          completionDelivery,
        },
      },
    });

    await expect(store.delete(card.id)).rejects.toThrow("delivery and cleanup complete");
    await store.markCompletionDeliveryCleanupCompleted({
      cardId: card.id,
      obligationId: completionDelivery.obligationId,
      completedAt: 30,
    });
    await expect(store.delete(card.id)).resolves.toEqual({ deleted: true });
  });

  it("only reassigns a terminal failed workflow when resetFailures is explicitly true", async () => {
    const store = new WorkboardStore(createSharedStore());
    const completionDelivery = {
      kind: "verified_workboard_completion" as const,
      obligationId: "obligation-failed",
      cardId: "failed-card",
      sessionKey: "agent:main:subagent:failed-worker",
      runId: "run-failed",
      payloadHash: "failed-payload",
      acceptedAt: 10,
      status: "failed" as const,
      lastError: "delivery exhausted",
    };
    const card = await store.create({
      title: "Terminal failed workflow",
      status: "blocked",
      agentId: "old-agent",
      sessionKey: completionDelivery.sessionKey,
      runId: completionDelivery.runId,
      execution: {
        id: "execution-failed",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "blocked",
        model: "default",
        sessionKey: completionDelivery.sessionKey,
        runId: completionDelivery.runId,
        startedAt: 1,
        updatedAt: 2,
      },
      metadata: {
        failureCount: 2,
        automation: {
          idempotencyKey: "failed-workflow",
          flowId: "flow-failed",
          flowOwnerSessionKey: "agent:main:main",
          flowRevision: 4,
          controllerId: "workboard",
          completionDelivery,
        },
      },
    });

    await expect(store.reassign(card.id, { agentId: "new-agent" })).rejects.toThrow(
      "trusted workflow controller",
    );
    await expect(
      store.reassign(card.id, { agentId: "new-agent", resetFailures: false }),
    ).rejects.toThrow("trusted workflow controller");
    const reset = await store.reassign(card.id, {
      agentId: "new-agent",
      status: "todo",
      resetFailures: true,
    });
    expect(reset).toMatchObject({ agentId: "new-agent", status: "todo" });
    expect(reset.sessionKey).toBeUndefined();
    expect(reset.runId).toBeUndefined();
    expect(reset.execution).toBeUndefined();
    expect(reset.metadata?.failureCount).toBeUndefined();
    expect(reset.metadata?.automation?.flowId).toBeUndefined();
    expect(reset.metadata?.automation?.controllerId).toBeUndefined();
    expect(reset.metadata?.automation?.completionDelivery).toBeUndefined();
    expect(reset.metadata?.automation?.idempotencyKey).not.toBe("failed-workflow");
  });
});
