// Subagent orphan-recovery tests cover restart recovery for child sessions whose
// embedded run was interrupted while the registry still considers them active.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sessions from "../config/sessions.js";
import * as gateway from "../gateway/call.js";
import * as sessionUtils from "../gateway/session-transcript-readers.js";
import { resolveInternalSessionEffectsTranscriptPath } from "./internal-session-effects.js";
import * as announceDelivery from "./subagent-announce-delivery.js";
import {
  recoverOrphanedSubagentSessions,
  scheduleOrphanRecovery,
} from "./subagent-orphan-recovery.js";
import * as subagentRegistrySteerRuntime from "./subagent-registry-steer-runtime.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import * as subagentTaskGeneration from "./subagent-task-generation.js";

// Mocks are installed before importing the recovery module so registry/runtime
// helpers resolve to deterministic restart fixtures.
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({
    session: { store: undefined },
  })),
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: vi.fn(() => ({})),
  resolveAgentIdFromSessionKey: vi.fn(() => "main"),
  resolveStorePath: vi.fn(() => "/tmp/test-sessions.json"),
  updateSessionStore: vi.fn(async () => {}),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ runId: "test-run-id" })),
}));

vi.mock("../infra/agent-events.js", () => ({
  getAgentRunContext: vi.fn(() => undefined),
}));

vi.mock("../tasks/detached-task-runtime.js", () => ({
  findDetachedTaskRunStrict: vi.fn(() => ({ lookup: "unavailable" })),
  startTaskRunByRunId: vi.fn(() => []),
}));

vi.mock("../tasks/task-status-access.js", () => ({
  listTasksForSessionKeyForStatusStrict: vi.fn(() => []),
}));

vi.mock("../gateway/session-transcript-readers.js", () => ({
  readSessionMessagesAsync: vi.fn(async () => []),
}));

vi.mock("./subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: vi.fn(async () => ({ delivered: true, path: "direct" })),
  isInternalAnnounceRequesterSession: vi.fn(() => false),
  loadRequesterSessionEntry: vi.fn(() => ({ entry: {} })),
}));

vi.mock("./subagent-announce-origin.js", () => ({
  resolveAnnounceOrigin: vi.fn((entry, requesterOrigin) => requesterOrigin),
}));

vi.mock("./subagent-registry-steer-runtime.js", () => ({
  claimSubagentOrphanRecovery: vi.fn(
    (params: { successorRunId: string }) =>
      ({ status: "claimed", successorRunId: params.successorRunId }) as const,
  ),
  markSubagentOrphanRecoveryDeclined: vi.fn(() => true),
  markSubagentOrphanRecoveryExhausted: vi.fn(() => true),
  replaceSubagentRunAfterSteer: vi.fn(() => true),
  finalizeInterruptedSubagentRun: vi.fn(async () => 1),
}));

vi.mock("./subagent-task-generation.js", () => ({
  tryCreateRecoveredSubagentTaskGeneration: vi.fn(() => ({
    task: null,
    error: "not configured",
  })),
}));

function createTestRunRecord(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:test-session-1",
    requesterSessionKey: "agent:main:quietchat:direct:+1234567890",
    requesterDisplayKey: "main",
    task: "Test task: implement feature X",
    cleanup: "delete",
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 55_000,
    ...overrides,
  };
}

function createActiveRuns(...runs: SubagentRunRecord[]) {
  return new Map(runs.map((run) => [run.runId, run] satisfies [string, SubagentRunRecord]));
}

function mockSingleAbortedSession(
  overrides: Partial<NonNullable<ReturnType<typeof sessions.loadSessionStore>[string]>> = {},
) {
  vi.mocked(sessions.loadSessionStore).mockReturnValue({
    "agent:main:subagent:test-session-1": {
      sessionId: "session-abc",
      updatedAt: Date.now(),
      abortedLastRun: true,
      ...overrides,
    },
  });
}

async function expectSkippedRecovery(store: ReturnType<typeof sessions.loadSessionStore>) {
  vi.mocked(sessions.loadSessionStore).mockReturnValue(store);

  const result = await recoverOrphanedSubagentSessions({
    getActiveRuns: () => createActiveRuns(createTestRunRecord()),
  });

  expect(result.recovered).toBe(0);
  expect(result.skipped).toBe(1);
  expect(gateway.callGateway).not.toHaveBeenCalled();
}

function getResumeMessage() {
  const call = requireRecord(
    firstCallParam(vi.mocked(gateway.callGateway).mock.calls, "resume gateway"),
    "resume gateway params",
  );
  const params = call.params as Record<string, unknown>;
  return params.message as string;
}

function firstCallParam(calls: ReadonlyArray<readonly unknown[]>, label: string) {
  const call = calls[0];
  if (call === undefined) {
    throw new Error(`expected ${label} call`);
  }
  return call[0];
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
}

function requireFirstUpdateSessionStoreCall() {
  const call = vi.mocked(sessions.updateSessionStore).mock.calls[0];
  if (call === undefined) {
    throw new Error("expected update session store call");
  }
  return call;
}

describe("subagent-orphan-recovery", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(gateway.callGateway).mockResolvedValue({ runId: "test-run-id" });
    vi.mocked(sessions.loadSessionStore).mockReturnValue({});
    vi.mocked(sessions.updateSessionStore).mockImplementation(async () => {});
    vi.mocked(sessionUtils.readSessionMessagesAsync).mockResolvedValue([]);
    vi.mocked(subagentRegistrySteerRuntime.claimSubagentOrphanRecovery).mockImplementation(
      (params) => ({ status: "claimed", successorRunId: params.successorRunId }),
    );
    vi.mocked(subagentRegistrySteerRuntime.markSubagentOrphanRecoveryDeclined).mockReturnValue(
      true,
    );
    vi.mocked(subagentRegistrySteerRuntime.markSubagentOrphanRecoveryExhausted).mockReturnValue(
      true,
    );
    vi.mocked(subagentRegistrySteerRuntime.replaceSubagentRunAfterSteer).mockReturnValue(true);
    const agentEvents = await import("../infra/agent-events.js");
    vi.mocked(agentEvents.getAgentRunContext).mockReturnValue(undefined);
    const detachedTasks = await import("../tasks/detached-task-runtime.js");
    vi.mocked(detachedTasks.findDetachedTaskRunStrict).mockReturnValue({ lookup: "unavailable" });
    vi.mocked(detachedTasks.startTaskRunByRunId).mockReturnValue([]);
    vi.mocked(subagentTaskGeneration.tryCreateRecoveredSubagentTaskGeneration).mockReturnValue({
      task: null,
      error: "not configured",
    });
    const taskStatus = await import("../tasks/task-status-access.js");
    vi.mocked(taskStatus.listTasksForSessionKeyForStatusStrict).mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("recovers orphaned sessions with abortedLastRun=true", async () => {
    const sessionEntry = {
      sessionId: "session-abc",
      updatedAt: Date.now(),
      abortedLastRun: true,
    };

    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": sessionEntry,
    });

    const run = createTestRunRecord();
    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set("run-1", run);

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result.recovered).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);

    // Recovery resumes through the gateway and records the new run id so the
    // registry follows the resumed transcript instead of the idempotency key.
    expect(gateway.callGateway).toHaveBeenCalledOnce();
    const opts = requireRecord(
      firstCallParam(vi.mocked(gateway.callGateway).mock.calls, "gateway resume"),
      "gateway resume params",
    );
    expect(opts.method).toBe("agent");
    const params = opts.params as Record<string, unknown>;
    expect(params.sessionKey).toBe("agent:main:subagent:test-session-1");
    expect(params.message).toContain("gateway reload");
    expect(params.message).toContain("Test task: implement feature X");
    expect(subagentRegistrySteerRuntime.replaceSubagentRunAfterSteer).toHaveBeenCalledOnce();
    const replaceParams = requireRecord(
      firstCallParam(
        vi.mocked(subagentRegistrySteerRuntime.replaceSubagentRunAfterSteer).mock.calls,
        "run replacement",
      ),
      "run replacement params",
    );
    expect(replaceParams.previousRunId).toBe("run-1");
    expect(replaceParams.nextRunId).toBe(params.idempotencyKey);
    expect(replaceParams.fallback).toBe(run);
    expect(replaceParams.transcriptFile).toBe(
      resolveInternalSessionEffectsTranscriptPath(params.idempotencyKey as string),
    );
    expect(replaceParams.createFreshTaskGeneration).toBe(true);
    expect(replaceParams.requireDurableReplacement).toBe(true);
  });

  it("never claims or resumes a run with a verified Workboard completion intent", async () => {
    mockSingleAbortedSession();
    const run = createTestRunRecord({
      cleanup: "keep",
      label: "plugin:workboard",
      endedAt: Date.now(),
      outcome: { status: "ok" },
      delivery: {
        status: "pending",
        obligationId: "workboard:card-1:completion",
        verifiedWorkboardCompletion: {
          kind: "verified_workboard_completion",
          obligationId: "workboard:card-1:completion",
          payloadHash: "a".repeat(64),
          acceptedAt: Date.now(),
          cardId: "card-1",
          childSessionKey: "agent:main:subagent:test-session-1",
          runId: "run-1",
          expectedRunId: "run-1",
          expectedRevision: "revision-1",
          claimOwnerId: "cairn",
          summary: "verified",
          completionText: "verified result",
          proof: { id: "proof-1", status: "passed", createdAt: Date.now() },
          artifacts: [
            {
              id: "artifact-1",
              createdAt: Date.now(),
              path: "/tmp/result.txt",
              byteSize: 1,
              sha256: "b".repeat(64),
              verifiedAt: Date.now(),
            },
          ],
          createdCardIds: [],
          flowId: "flow-card-1",
          flowOwnerSessionKey: "agent:main:quietchat:direct:+1234567890",
          requesterSessionKey: "agent:main:quietchat:direct:+1234567890",
          flowRevision: 3,
          controllerId: "workboard",
        },
      },
    });

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => createActiveRuns(run),
    });

    expect(result).toMatchObject({ recovered: 0, failed: 0, skipped: 1 });
    expect(subagentRegistrySteerRuntime.claimSubagentOrphanRecovery).not.toHaveBeenCalled();
    expect(gateway.callGateway).not.toHaveBeenCalled();
    expect(subagentRegistrySteerRuntime.replaceSubagentRunAfterSteer).not.toHaveBeenCalled();
  });

  it("reuses one durably preclaimed successor id after ambiguous gateway errors", async () => {
    mockSingleAbortedSession();
    vi.mocked(subagentRegistrySteerRuntime.claimSubagentOrphanRecovery).mockReturnValue({
      status: "claimed",
      successorRunId: "durable-successor-id",
    });
    vi.mocked(gateway.callGateway).mockRejectedValue(new Error("response connection closed"));
    const activeRuns = createActiveRuns(createTestRunRecord());

    await recoverOrphanedSubagentSessions({ getActiveRuns: () => activeRuns });
    await recoverOrphanedSubagentSessions({ getActiveRuns: () => activeRuns });

    expect(gateway.callGateway).toHaveBeenCalledTimes(2);
    const ids = vi
      .mocked(gateway.callGateway)
      .mock.calls.map((call) =>
        String(
          (requireRecord(call[0], "gateway call").params as Record<string, unknown>).idempotencyKey,
        ),
      );
    expect(ids).toEqual(["durable-successor-id", "durable-successor-id"]);
  });

  it("persists a queued successor task anchor before the gateway side effect", async () => {
    const detachedTasks = await import("../tasks/detached-task-runtime.js");
    mockSingleAbortedSession();
    const predecessorRunId = "run-1";
    const successorRunId = "anchored-successor";
    const childSessionKey = "agent:main:subagent:test-session-1";
    const predecessorTask = {
      taskId: "predecessor-task",
      runtime: "subagent" as const,
      requesterSessionKey: "agent:main:quietchat:direct:+1234567890",
      ownerKey: "agent:main:quietchat:direct:+1234567890",
      scopeKind: "session" as const,
      childSessionKey,
      runId: predecessorRunId,
      label: "plugin:workboard",
      task: "Test task: implement feature X",
      status: "running" as const,
      deliveryStatus: "not_applicable" as const,
      notifyPolicy: "silent" as const,
      createdAt: 100,
    };
    const queuedSuccessor = {
      ...predecessorTask,
      taskId: "successor-task",
      runId: successorRunId,
      status: "queued" as const,
      createdAt: 200,
    };
    const runningSuccessor = {
      ...queuedSuccessor,
      status: "running" as const,
      startedAt: 201,
    };
    vi.mocked(subagentRegistrySteerRuntime.claimSubagentOrphanRecovery).mockReturnValue({
      status: "claimed",
      successorRunId,
    });
    vi.mocked(detachedTasks.findDetachedTaskRunStrict).mockImplementation((params) =>
      params.runId === predecessorRunId
        ? { lookup: "available", task: predecessorTask }
        : { lookup: "unavailable" },
    );
    vi.mocked(subagentTaskGeneration.tryCreateRecoveredSubagentTaskGeneration).mockReturnValue({
      task: queuedSuccessor,
    });
    vi.mocked(detachedTasks.startTaskRunByRunId).mockReturnValue([runningSuccessor]);

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => createActiveRuns(createTestRunRecord({ label: "plugin:workboard" })),
    });

    expect(result).toMatchObject({ recovered: 1, failed: 0 });
    expect(subagentTaskGeneration.tryCreateRecoveredSubagentTaskGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: successorRunId,
        previousTask: predecessorTask,
        status: "queued",
      }),
    );
    expect(detachedTasks.startTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: successorRunId,
        runtime: "subagent",
        sessionKey: childSessionKey,
      }),
    );
    expect(
      vi.mocked(subagentTaskGeneration.tryCreateRecoveredSubagentTaskGeneration).mock
        .invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(gateway.callGateway).mock.invocationCallOrder[0]!);
    expect(vi.mocked(gateway.callGateway).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(detachedTasks.startTaskRunByRunId).mock.invocationCallOrder[0]!,
    );
    expect(
      vi.mocked(subagentRegistrySteerRuntime.replaceSubagentRunAfterSteer),
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        nextRunId: successorRunId,
        taskGenerationAlreadyCreated: true,
      }),
    );
  });

  it("durably remaps an accepted successor when the gateway response errors", async () => {
    const agentEvents = await import("../infra/agent-events.js");
    mockSingleAbortedSession();
    vi.mocked(subagentRegistrySteerRuntime.claimSubagentOrphanRecovery).mockReturnValue({
      status: "claimed",
      successorRunId: "accepted-successor-id",
    });
    vi.mocked(agentEvents.getAgentRunContext).mockImplementation((runId) =>
      runId === "accepted-successor-id"
        ? ({ runId, sessionKey: "agent:main:subagent:test-session-1" } as never)
        : undefined,
    );
    vi.mocked(gateway.callGateway).mockRejectedValue(new Error("response lost after accept"));

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => createActiveRuns(createTestRunRecord()),
    });

    expect(result).toMatchObject({ recovered: 1, failed: 0 });
    expect(subagentRegistrySteerRuntime.replaceSubagentRunAfterSteer).toHaveBeenCalledWith(
      expect.objectContaining({
        previousRunId: "run-1",
        nextRunId: "accepted-successor-id",
        requireDurableReplacement: true,
      }),
    );
  });

  it("reconciles one exact latest durable successor before issuing a duplicate start", async () => {
    const detachedTasks = await import("../tasks/detached-task-runtime.js");
    const taskStatus = await import("../tasks/task-status-access.js");
    mockSingleAbortedSession();
    const successorRunId = "durable-exact-successor";
    const childSessionKey = "agent:main:subagent:test-session-1";
    const task = {
      taskId: "durable-exact-task",
      runtime: "subagent" as const,
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session" as const,
      childSessionKey,
      runId: successorRunId,
      label: "plugin:workboard",
      task: "accepted durable successor",
      status: "running" as const,
      deliveryStatus: "pending" as const,
      notifyPolicy: "done_only" as const,
      createdAt: 200,
    };
    vi.mocked(subagentRegistrySteerRuntime.claimSubagentOrphanRecovery).mockReturnValue({
      status: "claimed",
      successorRunId,
    });
    vi.mocked(detachedTasks.findDetachedTaskRunStrict).mockReturnValue({
      lookup: "available",
      task,
    });
    vi.mocked(taskStatus.listTasksForSessionKeyForStatusStrict).mockReturnValue([task]);

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => createActiveRuns(createTestRunRecord({ label: "plugin:workboard" })),
    });

    expect(result).toMatchObject({ recovered: 1, failed: 0 });
    expect(gateway.callGateway).not.toHaveBeenCalled();
    expect(subagentRegistrySteerRuntime.replaceSubagentRunAfterSteer).toHaveBeenCalledOnce();
  });

  it("does not trust mismatched durable successor evidence", async () => {
    const detachedTasks = await import("../tasks/detached-task-runtime.js");
    const taskStatus = await import("../tasks/task-status-access.js");
    mockSingleAbortedSession();
    vi.mocked(subagentRegistrySteerRuntime.claimSubagentOrphanRecovery).mockReturnValue({
      status: "claimed",
      successorRunId: "expected-successor",
    });
    const mismatchedTask = {
      taskId: "mismatched-task",
      runtime: "subagent" as const,
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session" as const,
      childSessionKey: "agent:main:subagent:wrong-session",
      runId: "different-successor",
      label: "plugin:workboard",
      task: "wrong durable successor",
      status: "running" as const,
      deliveryStatus: "pending" as const,
      notifyPolicy: "done_only" as const,
      createdAt: 200,
    };
    const predecessorTask = {
      taskId: "predecessor-task",
      runtime: "subagent" as const,
      requesterSessionKey: "agent:main:quietchat:direct:+1234567890",
      ownerKey: "agent:main:quietchat:direct:+1234567890",
      scopeKind: "session" as const,
      childSessionKey: "agent:main:subagent:test-session-1",
      runId: "run-1",
      label: "plugin:workboard",
      task: "original durable predecessor",
      status: "running" as const,
      deliveryStatus: "pending" as const,
      notifyPolicy: "done_only" as const,
      createdAt: 100,
    };
    const queuedSuccessorTask = {
      ...predecessorTask,
      taskId: "expected-successor-task",
      runId: "expected-successor",
      status: "queued" as const,
      createdAt: 300,
    };
    const runningSuccessorTask = {
      ...queuedSuccessorTask,
      status: "running" as const,
    };
    vi.mocked(detachedTasks.findDetachedTaskRunStrict).mockImplementation(({ runId }) => ({
      lookup: "available",
      task: runId === "run-1" ? predecessorTask : mismatchedTask,
    }));
    vi.mocked(subagentTaskGeneration.tryCreateRecoveredSubagentTaskGeneration).mockReturnValue({
      task: queuedSuccessorTask,
    });
    vi.mocked(detachedTasks.startTaskRunByRunId).mockReturnValue([runningSuccessorTask]);
    vi.mocked(taskStatus.listTasksForSessionKeyForStatusStrict).mockReturnValue([mismatchedTask]);

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => createActiveRuns(createTestRunRecord({ label: "plugin:workboard" })),
    });

    expect(result).toMatchObject({ recovered: 1, failed: 0 });
    expect(gateway.callGateway).toHaveBeenCalledOnce();
    const gatewayParams = requireRecord(
      requireRecord(
        firstCallParam(vi.mocked(gateway.callGateway).mock.calls, "mismatched evidence retry"),
        "gateway retry",
      ).params,
      "gateway retry params",
    );
    expect(gatewayParams.idempotencyKey).toBe("expected-successor");
  });

  it("does not replay a stale aborted flag against an accepted successor generation", async () => {
    mockSingleAbortedSession({ updatedAt: 1_000 });
    const successor = createTestRunRecord({
      runId: "accepted-successor-run",
      createdAt: 2_000,
      startedAt: 2_000,
      execution: {
        status: "running",
        startedAt: 2_000,
      },
    });

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => createActiveRuns(successor),
    });

    expect(result).toMatchObject({ recovered: 0, failed: 0, skipped: 1 });
    expect(gateway.callGateway).not.toHaveBeenCalled();
  });

  it("single-flights concurrent orphan recovery scans per child session", async () => {
    mockSingleAbortedSession();
    let resolveGateway: ((value: { runId: string }) => void) | undefined;
    vi.mocked(gateway.callGateway).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveGateway = resolve;
        }),
    );
    const activeRuns = createActiveRuns(createTestRunRecord());

    const first = recoverOrphanedSubagentSessions({ getActiveRuns: () => activeRuns });
    await vi.waitFor(() => expect(gateway.callGateway).toHaveBeenCalledTimes(1));
    const second = recoverOrphanedSubagentSessions({ getActiveRuns: () => activeRuns });
    await Promise.resolve();
    await Promise.resolve();

    expect(gateway.callGateway).toHaveBeenCalledTimes(1);
    resolveGateway?.({ runId: "single-flight-successor" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ recovered: 1, failed: 0 }),
      expect.objectContaining({ recovered: 0, failed: 0, skipped: 1 }),
    ]);
  });

  it("skips sessions that are not aborted", async () => {
    await expectSkippedRecovery({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: false,
      },
    });
  });

  it("skips runs that have already ended", async () => {
    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set(
      "run-1",
      createTestRunRecord({
        endedAt: Date.now() - 1000,
      }),
    );

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result.recovered).toBe(0);
    expect(result.skipped).toBe(1);
    expect(gateway.callGateway).not.toHaveBeenCalled();
  });

  it("recovers restart-aborted timeout runs even when the registry marked them ended", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
    });

    const activeRuns = createActiveRuns(
      createTestRunRecord({
        endedAt: Date.now() - 1_000,
        outcome: {
          status: "timeout",
        },
      }),
    );

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result.recovered).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(gateway.callGateway).toHaveBeenCalledOnce();
  });

  it("recovers restart-aborted Codex bridge closures even when the registry marked them ended", async () => {
    mockSingleAbortedSession();
    const endedAt = Date.now() - 1_000;
    const run = createTestRunRecord({
      endedAt,
      endedReason: "subagent-error",
      outcome: {
        status: "error",
        error: "Error: codex app-server client closed before turn completed",
      },
      execution: {
        status: "terminal",
        endedAt,
        outcome: {
          status: "error",
          error: "Error: codex app-server client closed before turn completed",
        },
      },
      cleanupHandled: true,
      cleanupCompletedAt: endedAt,
    });

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => createActiveRuns(run),
    });

    expect(result).toMatchObject({ recovered: 1, failed: 0, skipped: 0 });
    expect(gateway.callGateway).toHaveBeenCalledOnce();
    expect(run).toMatchObject({
      endedAt: undefined,
      endedReason: undefined,
      outcome: undefined,
      execution: {
        status: "interrupted",
        interruptedAt: endedAt,
        interruptionReason: "gateway-restart",
        endedAt: undefined,
        outcome: undefined,
      },
    });
  });

  it("recovers service-restart gateway closures when the child session still says running", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: false,
        status: "running",
      },
    });
    const endedAt = Date.now() - 1_000;
    const run = createTestRunRecord({
      endedAt,
      endedReason: "subagent-error",
      outcome: {
        status: "error",
        error:
          "gateway closed (1012): service restart\nGateway target: ws://127.0.0.1:18789\nSource: local loopback",
      },
      execution: {
        status: "terminal",
        endedAt,
        outcome: {
          status: "error",
          error: "gateway closed (1012): service restart",
        },
      },
      cleanupHandled: true,
      cleanupCompletedAt: endedAt,
    });

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => createActiveRuns(run),
    });

    expect(result).toMatchObject({ recovered: 1, failed: 0, skipped: 0 });
    expect(gateway.callGateway).toHaveBeenCalledOnce();
    expect(run).toMatchObject({
      endedAt: undefined,
      endedReason: undefined,
      outcome: undefined,
      execution: {
        status: "interrupted",
        interruptedAt: endedAt,
        interruptionReason: "gateway-restart",
        endedAt: undefined,
        outcome: undefined,
      },
    });
  });

  it("preserves service-restart gateway evidence until a retry is accepted", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: false,
        status: "running",
      },
    });
    vi.mocked(gateway.callGateway)
      .mockRejectedValueOnce(new Error("gateway still booting"))
      .mockResolvedValueOnce({ runId: "resumed-run" } as never);
    const endedAt = Date.now() - 1_000;
    const run = createTestRunRecord({
      endedAt,
      endedReason: "subagent-error",
      outcome: {
        status: "error",
        error: "gateway closed (1012): service restart",
      },
      execution: {
        status: "terminal",
        endedAt,
        outcome: {
          status: "error",
          error: "gateway closed (1012): service restart",
        },
      },
    });
    const activeRuns = createActiveRuns(run);

    const first = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(first).toMatchObject({ recovered: 0, failed: 1, skipped: 0 });
    expect(run).toMatchObject({
      endedAt,
      endedReason: "subagent-error",
      outcome: {
        status: "error",
        error: "gateway closed (1012): service restart",
      },
    });

    const second = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(second).toMatchObject({ recovered: 1, failed: 0, skipped: 0 });
    expect(gateway.callGateway).toHaveBeenCalledTimes(2);
  });

  it("does not revive a completed session after a service-restart gateway closure", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: false,
        status: "done",
      },
    });
    const activeRuns = createActiveRuns(
      createTestRunRecord({
        endedAt: Date.now() - 1_000,
        endedReason: "subagent-error",
        outcome: {
          status: "error",
          error: "gateway closed (1012): service restart",
        },
      }),
    );

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result).toMatchObject({ recovered: 0, failed: 0, skipped: 1 });
    expect(gateway.callGateway).not.toHaveBeenCalled();
  });

  it("recovers a core-preclaimed run from exact detached-task restart evidence", async () => {
    const detachedTasks = await import("../tasks/detached-task-runtime.js");
    const childSessionKey = "agent:main:subagent:test-session-1";
    const predecessorRunId = "run-1";
    const successorRunId = "task-evidence-successor";
    const predecessorTask = {
      taskId: "task-evidence-predecessor",
      runtime: "subagent" as const,
      requesterSessionKey: "agent:main:quietchat:direct:+1234567890",
      ownerKey: "agent:main:quietchat:direct:+1234567890",
      scopeKind: "session" as const,
      childSessionKey,
      runId: predecessorRunId,
      task: "resume after detached task restart failure",
      status: "failed" as const,
      deliveryStatus: "not_applicable" as const,
      notifyPolicy: "silent" as const,
      createdAt: Date.now() - 60_000,
      endedAt: Date.now() - 1_000,
      error: "gateway closed (1012): service restart",
    };
    const queuedSuccessor = {
      ...predecessorTask,
      taskId: "task-evidence-successor-task",
      runId: successorRunId,
      status: "queued" as const,
      createdAt: Date.now(),
      endedAt: undefined,
      error: undefined,
    };
    const runningSuccessor = {
      ...queuedSuccessor,
      status: "running" as const,
      startedAt: Date.now(),
    };
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      [childSessionKey]: {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: false,
        status: "failed",
      },
    });
    vi.mocked(subagentRegistrySteerRuntime.claimSubagentOrphanRecovery).mockReturnValue({
      status: "claimed",
      successorRunId,
    });
    vi.mocked(detachedTasks.findDetachedTaskRunStrict).mockImplementation(({ runId }) =>
      runId === predecessorRunId
        ? { lookup: "available", task: predecessorTask }
        : { lookup: "unavailable" },
    );
    vi.mocked(subagentTaskGeneration.tryCreateRecoveredSubagentTaskGeneration).mockReturnValue({
      task: queuedSuccessor,
    });
    vi.mocked(detachedTasks.startTaskRunByRunId).mockReturnValue([runningSuccessor]);
    const run = createTestRunRecord({
      orphanRecovery: {
        status: "core_owned",
        predecessorRunId,
        rootRunId: predecessorRunId,
        successorRunId,
        claimedAt: Date.now() - 1_000,
        updatedAt: Date.now() - 1_000,
      },
    });

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => createActiveRuns(run),
    });

    expect(result).toMatchObject({ recovered: 1, failed: 0, skipped: 0 });
    expect(subagentRegistrySteerRuntime.markSubagentOrphanRecoveryDeclined).not.toHaveBeenCalled();
    expect(gateway.callGateway).toHaveBeenCalledOnce();
  });

  it("does not consume recovery ownership before a stale run gains interruption evidence", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: false,
        status: "running",
      },
    });
    let ownership: "available" | "owned" | "declined" = "available";
    vi.mocked(subagentRegistrySteerRuntime.claimSubagentOrphanRecovery).mockImplementation(
      (params) => {
        if (ownership === "declined") {
          return { status: "exhausted" };
        }
        ownership = "owned";
        return { status: "claimed", successorRunId: params.successorRunId };
      },
    );
    vi.mocked(subagentRegistrySteerRuntime.markSubagentOrphanRecoveryDeclined).mockImplementation(
      () => {
        ownership = "declined";
        return true;
      },
    );
    const run = createTestRunRecord({
      execution: { status: "running" },
    });
    const activeRuns = createActiveRuns(run);

    const earlyScan = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(earlyScan).toMatchObject({ recovered: 0, failed: 0, skipped: 1 });
    expect(subagentRegistrySteerRuntime.claimSubagentOrphanRecovery).not.toHaveBeenCalled();
    expect(subagentRegistrySteerRuntime.markSubagentOrphanRecoveryDeclined).not.toHaveBeenCalled();

    run.execution = {
      status: "interrupted",
      interruptedAt: Date.now(),
      interruptionReason: "lost-execution-context",
    };
    const recoveryScan = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(recoveryScan).toMatchObject({ recovered: 1, failed: 0, skipped: 0 });
    expect(gateway.callGateway).toHaveBeenCalledOnce();
  });

  it("recovers stale runs terminalized after restart with lost execution context", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: false,
        status: "failed",
      },
    });
    const endedAt = Date.now() - 1_000;
    const run = createTestRunRecord({
      endedAt,
      endedReason: "subagent-error",
      outcome: {
        status: "error",
        error: "subagent run lost active execution context",
      },
      execution: {
        status: "terminal",
        endedAt,
        outcome: {
          status: "error",
          error: "subagent run lost active execution context",
        },
      },
      cleanupHandled: true,
      cleanupCompletedAt: endedAt,
    });

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => createActiveRuns(run),
    });

    expect(result).toMatchObject({ recovered: 1, failed: 0, skipped: 0 });
    expect(gateway.callGateway).toHaveBeenCalledOnce();
    expect(run).toMatchObject({
      endedAt: undefined,
      endedReason: undefined,
      outcome: undefined,
      execution: {
        status: "interrupted",
        interruptedAt: endedAt,
        interruptionReason: "gateway-restart",
        endedAt: undefined,
        outcome: undefined,
      },
    });
  });

  it("recovers runs durably interrupted after losing active execution context", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: false,
        status: "running",
      },
    });
    const interruptedAt = Date.now() - 1_000;
    const run = createTestRunRecord({
      execution: {
        status: "interrupted",
        interruptedAt,
        interruptionReason: "lost-execution-context",
      },
    });

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => createActiveRuns(run),
    });

    expect(result).toMatchObject({ recovered: 1, failed: 0, skipped: 0 });
    expect(gateway.callGateway).toHaveBeenCalledOnce();
  });

  it("does not revive completed sessions with a lost-context terminal result", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: false,
        status: "done",
      },
    });
    const activeRuns = createActiveRuns(
      createTestRunRecord({
        endedAt: Date.now() - 1_000,
        endedReason: "subagent-error",
        outcome: {
          status: "error",
          error: "subagent run lost active execution context",
        },
      }),
    );

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result).toMatchObject({ recovered: 0, failed: 0, skipped: 1 });
    expect(gateway.callGateway).not.toHaveBeenCalled();
  });

  it("does not revive a restart-aborted run with an unrelated terminal error", async () => {
    mockSingleAbortedSession();
    const activeRuns = createActiveRuns(
      createTestRunRecord({
        endedAt: Date.now() - 1_000,
        endedReason: "subagent-error",
        outcome: {
          status: "error",
          error: "provider rejected the request",
        },
      }),
    );

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result).toMatchObject({ recovered: 0, failed: 0, skipped: 1 });
    expect(gateway.callGateway).not.toHaveBeenCalled();
  });

  it("handles multiple orphaned sessions", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:session-a": {
        sessionId: "id-a",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
      "agent:main:subagent:session-b": {
        sessionId: "id-b",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
      "agent:main:subagent:session-c": {
        sessionId: "id-c",
        updatedAt: Date.now(),
        abortedLastRun: false,
      },
    });

    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set(
      "run-a",
      createTestRunRecord({
        runId: "run-a",
        childSessionKey: "agent:main:subagent:session-a",
        task: "Task A",
      }),
    );
    activeRuns.set(
      "run-b",
      createTestRunRecord({
        runId: "run-b",
        childSessionKey: "agent:main:subagent:session-b",
        task: "Task B",
      }),
    );
    activeRuns.set(
      "run-c",
      createTestRunRecord({
        runId: "run-c",
        childSessionKey: "agent:main:subagent:session-c",
        task: "Task C",
      }),
    );

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result.recovered).toBe(2);
    expect(result.skipped).toBe(1);
    expect(gateway.callGateway).toHaveBeenCalledTimes(2);
  });

  it("recovers only the newest run generation for one child session", async () => {
    mockSingleAbortedSession();
    const older = createTestRunRecord({
      runId: "run-older",
      generation: 1,
      createdAt: Date.now() - 20_000,
      task: "Old task with an expired claim token",
    });
    const newer = createTestRunRecord({
      runId: "run-newer",
      generation: 2,
      createdAt: Date.now() - 10_000,
      task: "Current task with the valid claim token",
    });

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => createActiveRuns(older, newer),
    });

    expect(result).toMatchObject({ recovered: 1, failed: 0, skipped: 1 });
    expect(gateway.callGateway).toHaveBeenCalledOnce();
    expect(getResumeMessage()).toContain("Current task with the valid claim token");
    expect(getResumeMessage()).not.toContain("Old task with an expired claim token");
    expect(subagentRegistrySteerRuntime.replaceSubagentRunAfterSteer).toHaveBeenCalledWith(
      expect.objectContaining({ previousRunId: "run-newer" }),
    );
  });

  it("handles callGateway failure gracefully and preserves abortedLastRun flag", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
    });

    vi.mocked(gateway.callGateway).mockRejectedValue(new Error("gateway unavailable"));

    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set("run-1", createTestRunRecord());

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.failedRuns).toHaveLength(1);
    const failedRun = requireRecord(result.failedRuns[0], "failed run");
    expect(failedRun.runId).toBe("run-1");
    expect(failedRun.childSessionKey).toBe("agent:main:subagent:test-session-1");
    expect(failedRun.error).toBe("gateway unavailable");

    // abortedLastRun flag should NOT be cleared on failure,
    // so the next restart can retry the recovery
    expect(sessions.updateSessionStore).not.toHaveBeenCalled();
  });

  it("returns empty results when no active runs exist", async () => {
    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => new Map(),
    });

    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("skips sessions with missing session entry in store", async () => {
    await expectSkippedRecovery({});
  });

  it("clears abortedLastRun flag after successful resume", async () => {
    // Ensure callGateway succeeds for this test
    vi.mocked(gateway.callGateway).mockResolvedValue({ runId: "resumed-run" } as never);

    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
    });

    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set("run-1", createTestRunRecord());

    await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    // updateSessionStore should have been called AFTER successful resume to clear the flag
    expect(sessions.updateSessionStore).toHaveBeenCalledOnce();
    const calls = vi.mocked(sessions.updateSessionStore).mock.calls;
    const [storePath, updater] = calls[0];
    expect(storePath).toBe("/tmp/test-sessions.json");

    // Simulate the updater to verify it clears abortedLastRun
    const mockStore: Record<string, { abortedLastRun?: boolean; updatedAt?: number }> = {
      "agent:main:subagent:test-session-1": {
        abortedLastRun: true,
        updatedAt: 0,
      },
    };
    (updater as (store: Record<string, unknown>) => void)(mockStore);
    expect(mockStore["agent:main:subagent:test-session-1"]?.abortedLastRun).toBe(false);
  });

  it("persists accepted recovery attempts after successful resume", async () => {
    vi.mocked(gateway.callGateway).mockResolvedValue({ runId: "resumed-run" } as never);
    mockSingleAbortedSession();

    await recoverOrphanedSubagentSessions({
      getActiveRuns: () => createActiveRuns(createTestRunRecord()),
    });

    const updateCall = requireFirstUpdateSessionStoreCall();
    const updater = updateCall[1];
    if (typeof updater !== "function") {
      throw new Error("expected update session store callback");
    }
    const mockStore: ReturnType<typeof sessions.loadSessionStore> = {
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: 0,
        abortedLastRun: true,
      },
    };
    await updater(mockStore);
    const sessionEntry = requireRecord(
      mockStore["agent:main:subagent:test-session-1"],
      "updated session entry",
    );
    expect(sessionEntry.abortedLastRun).toBe(false);
    const recovery = requireRecord(sessionEntry.subagentRecovery, "subagent recovery");
    expect(recovery.automaticAttempts).toBe(1);
    expect(recovery.lastRunId).toBe("run-1");
    expect(recovery.lastAttemptAt).toBeTypeOf("number");
  });

  it("tombstones rapid repeated accepted recovery before resuming again", async () => {
    const now = Date.now();
    mockSingleAbortedSession({
      subagentRecovery: {
        automaticAttempts: 2,
        lastAttemptAt: now - 30_000,
        lastRunId: "previous-run",
      },
    });

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => createActiveRuns(createTestRunRecord()),
    });

    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.failedRuns).toHaveLength(1);
    const blockedRun = requireRecord(result.failedRuns[0], "blocked run");
    expect(blockedRun.runId).toBe("run-1");
    expect(blockedRun.childSessionKey).toBe("agent:main:subagent:test-session-1");
    expect(blockedRun.error).toContain("recovery blocked after 2 rapid accepted resume attempts");
    expect(gateway.callGateway).not.toHaveBeenCalled();
    expect(sessions.updateSessionStore).toHaveBeenCalledOnce();

    const updateCall = requireFirstUpdateSessionStoreCall();
    const updater = updateCall[1];
    if (typeof updater !== "function") {
      throw new Error("expected update session store callback");
    }
    const mockStore: ReturnType<typeof sessions.loadSessionStore> = {
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: 0,
        abortedLastRun: true,
        subagentRecovery: {
          automaticAttempts: 2,
          lastAttemptAt: now - 30_000,
          lastRunId: "previous-run",
        },
      },
    };
    await updater(mockStore);
    const sessionEntry = requireRecord(
      mockStore["agent:main:subagent:test-session-1"],
      "wedged session entry",
    );
    expect(sessionEntry.abortedLastRun).toBe(false);
    const recovery = requireRecord(sessionEntry.subagentRecovery, "wedged recovery");
    expect(recovery.automaticAttempts).toBe(2);
    expect(recovery.lastRunId).toBe("run-1");
    expect(recovery.wedgedAt).toBeTypeOf("number");
    expect(recovery.wedgedReason).toContain("recovery blocked");
  });

  it("skips already tombstoned wedged sessions without rewriting them", async () => {
    mockSingleAbortedSession({
      subagentRecovery: {
        automaticAttempts: 2,
        lastAttemptAt: Date.now() - 20_000,
        lastRunId: "previous-run",
        wedgedAt: Date.now() - 10_000,
        wedgedReason: "subagent orphan recovery blocked after 2 rapid accepted resume attempts",
      },
    });

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => createActiveRuns(createTestRunRecord()),
    });

    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.failedRuns).toHaveLength(1);
    expect(gateway.callGateway).not.toHaveBeenCalled();
    expect(sessions.updateSessionStore).not.toHaveBeenCalled();
  });

  it("truncates long task descriptions in resume message", async () => {
    mockSingleAbortedSession();

    const longTask = "x".repeat(5000);
    const activeRuns = createActiveRuns(createTestRunRecord({ task: longTask }));

    await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    const message = getResumeMessage();
    // Message should contain truncated task (2000 chars + "...")
    expect(message.length).toBeLessThan(5000);
    expect(message).toContain("...");
  });

  it("includes last human message in resume when available", async () => {
    mockSingleAbortedSession({ sessionFile: "session-abc.jsonl" });

    vi.mocked(sessionUtils.readSessionMessagesAsync).mockResolvedValue([
      { role: "user", content: [{ type: "text", text: "Please build feature Y" }] },
      { role: "assistant", content: [{ type: "text", text: "Working on it..." }] },
      { role: "user", content: [{ type: "text", text: "Also add tests for it" }] },
      { role: "assistant", content: [{ type: "text", text: "Sure, adding tests now." }] },
    ]);

    const activeRuns = createActiveRuns(createTestRunRecord());

    await recoverOrphanedSubagentSessions({ getActiveRuns: () => activeRuns });

    const message = getResumeMessage();
    expect(message).toContain("Also add tests for it");
    expect(message).toContain("last message from the user");
  });

  it("adds config change hint when assistant messages reference config modifications", async () => {
    mockSingleAbortedSession();

    vi.mocked(sessionUtils.readSessionMessagesAsync).mockResolvedValue([
      { role: "user", content: "Update the config" },
      { role: "assistant", content: "I've modified openclaw.json to add the new setting." },
    ]);

    const activeRuns = createActiveRuns(createTestRunRecord());

    await recoverOrphanedSubagentSessions({ getActiveRuns: () => activeRuns });

    const message = getResumeMessage();
    expect(message).toContain("config changes from your previous run were already applied");
  });

  it("does not send parent-visible recovery-progress announcements on retry", async () => {
    mockSingleAbortedSession();

    const activeRuns = createActiveRuns(createTestRunRecord());

    await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(announceDelivery.deliverSubagentAnnouncement).not.toHaveBeenCalled();

    await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(announceDelivery.deliverSubagentAnnouncement).not.toHaveBeenCalled();
  });

  it("prevents duplicate resume when updateSessionStore fails", async () => {
    vi.mocked(gateway.callGateway).mockResolvedValue({ runId: "new-run" } as never);
    vi.mocked(sessions.updateSessionStore).mockRejectedValue(new Error("write failed"));

    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
    });

    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set("run-1", createTestRunRecord());
    activeRuns.set(
      "run-2",
      createTestRunRecord({
        runId: "run-2",
      }),
    );

    const result = await recoverOrphanedSubagentSessions({ getActiveRuns: () => activeRuns });

    expect(result.recovered).toBe(1);
    expect(result.skipped).toBe(1);
    expect(gateway.callGateway).toHaveBeenCalledOnce();
  });

  it("retries the same successor id after a crash before durable run replacement", async () => {
    vi.mocked(gateway.callGateway).mockResolvedValue({ runId: "new-run" } as never);
    vi.mocked(subagentRegistrySteerRuntime.claimSubagentOrphanRecovery).mockReturnValue({
      status: "claimed",
      successorRunId: "crash-safe-successor",
    });
    vi.mocked(subagentRegistrySteerRuntime.replaceSubagentRunAfterSteer)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
    });

    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set("run-1", createTestRunRecord());
    const resumedSessionKeys = new Set<string>();

    const first = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
      resumedSessionKeys,
    });
    const second = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
      resumedSessionKeys,
    });

    expect(first.recovered).toBe(0);
    expect(first.failed).toBe(1);
    expect(second.recovered).toBe(1);
    expect(second.failed).toBe(0);
    expect(gateway.callGateway).toHaveBeenCalledTimes(2);
    const ids = vi
      .mocked(gateway.callGateway)
      .mock.calls.map((call) =>
        String(
          (requireRecord(call[0], "gateway call").params as Record<string, unknown>).idempotencyKey,
        ),
      );
    expect(ids).toEqual(["crash-safe-successor", "crash-safe-successor"]);
    expect(sessions.updateSessionStore).toHaveBeenCalledOnce();
  });

  it("reconciles accepted successor evidence before retrying without a duplicate start", async () => {
    const agentEvents = await import("../infra/agent-events.js");
    mockSingleAbortedSession();
    vi.mocked(subagentRegistrySteerRuntime.claimSubagentOrphanRecovery).mockReturnValue({
      status: "claimed",
      successorRunId: "accepted-before-crash",
    });
    vi.mocked(subagentRegistrySteerRuntime.replaceSubagentRunAfterSteer)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const activeRuns = createActiveRuns(createTestRunRecord({ label: undefined }));

    const first = await recoverOrphanedSubagentSessions({ getActiveRuns: () => activeRuns });
    expect(first).toMatchObject({ recovered: 0, failed: 1 });
    vi.mocked(agentEvents.getAgentRunContext).mockReturnValue({
      sessionKey: "agent:main:subagent:test-session-1",
    });

    const second = await recoverOrphanedSubagentSessions({ getActiveRuns: () => activeRuns });

    expect(second).toMatchObject({ recovered: 1, failed: 0 });
    expect(gateway.callGateway).toHaveBeenCalledTimes(1);
    expect(subagentRegistrySteerRuntime.replaceSubagentRunAfterSteer).toHaveBeenCalledTimes(2);
  });

  it("preclaims every delayed session before asynchronous scanning begins", () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:session-a": {
        sessionId: "session-a",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
      "agent:main:subagent:session-b": {
        sessionId: "session-b",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
    });
    const runs = createActiveRuns(
      createTestRunRecord({
        runId: "run-a",
        childSessionKey: "agent:main:subagent:session-a",
      }),
      createTestRunRecord({
        runId: "run-b",
        childSessionKey: "agent:main:subagent:session-b",
      }),
    );

    scheduleOrphanRecovery({ getActiveRuns: () => runs, delayMs: 5_000, maxRetries: 0 });

    expect(subagentRegistrySteerRuntime.claimSubagentOrphanRecovery).toHaveBeenCalledTimes(2);
    expect(gateway.callGateway).not.toHaveBeenCalled();
  });

  it("durably exhausts preclaimed sessions after a scan-level failure", async () => {
    mockSingleAbortedSession();
    const runs = createActiveRuns(createTestRunRecord());
    let reads = 0;
    scheduleOrphanRecovery({
      getActiveRuns: () => {
        reads += 1;
        if (reads === 1) {
          return runs;
        }
        throw new Error("registry scan unavailable");
      },
      delayMs: 1,
      maxRetries: 0,
    });

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() =>
      expect(subagentRegistrySteerRuntime.markSubagentOrphanRecoveryExhausted).toHaveBeenCalledWith(
        expect.objectContaining({
          predecessorRunId: "run-1",
          childSessionKey: "agent:main:subagent:test-session-1",
        }),
      ),
    );
  });

  it("durably declines an already-preclaimed run that has no resumable session entry", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({});

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () =>
        createActiveRuns(
          createTestRunRecord({
            orphanRecovery: {
              status: "core_owned",
              predecessorRunId: "run-1",
              rootRunId: "run-1",
              successorRunId: "run-2",
              claimedAt: Date.now() - 1_000,
              updatedAt: Date.now() - 1_000,
            },
          }),
        ),
    });

    expect(result).toMatchObject({ recovered: 0, failed: 0, skipped: 1 });
    expect(subagentRegistrySteerRuntime.markSubagentOrphanRecoveryDeclined).toHaveBeenCalledWith(
      expect.objectContaining({
        predecessorRunId: "run-1",
        childSessionKey: "agent:main:subagent:test-session-1",
      }),
    );
  });

  it("finalizes interrupted runs with a readable failure after recovery retries are exhausted", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
    });
    vi.mocked(gateway.callGateway).mockRejectedValue(new Error("service restart"));

    const activeRuns = createActiveRuns(createTestRunRecord());

    scheduleOrphanRecovery({
      getActiveRuns: () => activeRuns,
      delayMs: 1,
      maxRetries: 1,
    });

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2);
    await Promise.resolve();

    expect(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun).toHaveBeenCalledOnce();
    const finalizeParams = requireRecord(
      firstCallParam(
        vi.mocked(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun).mock.calls,
        "interrupted run finalization",
      ),
      "interrupted run finalization params",
    );
    expect(finalizeParams.runId).toBe("run-1");
    expect(finalizeParams.childSessionKey).toBe("agent:main:subagent:test-session-1");
    expect(finalizeParams.error).toContain("Automatic recovery failed after 2 attempts");
    expect(finalizeParams.error).toContain("service restart");
  });
});
