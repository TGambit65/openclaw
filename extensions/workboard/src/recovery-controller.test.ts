// Workboard tests cover durable recovery-controller scheduling.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkboardRecoveryController } from "./recovery-controller.js";

function emptyRecoveryResult(overrides: { needsContinuation?: boolean } = {}) {
  return {
    reconciled: [],
    started: [],
    failures: [],
    needsContinuation: false,
    ...overrides,
  };
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createWorkboardRecoveryController", () => {
  it("runs a trailing reconciliation when a request arrives during an active pass", async () => {
    let finishFirst!: (value: ReturnType<typeof emptyRecoveryResult>) => void;
    const firstPass = new Promise<ReturnType<typeof emptyRecoveryResult>>((resolve) => {
      finishFirst = resolve;
    });
    const runRecovery = vi
      .fn()
      .mockImplementationOnce(async () => await firstPass)
      .mockResolvedValue(emptyRecoveryResult());
    const controller = createWorkboardRecoveryController({
      runRecovery,
      settleTerminatedRun: vi.fn(),
      cleanupRun: vi.fn(),
      logger: createLogger(),
    });

    const active = controller.request("startup");
    const trailing = controller.request("subagent-ended");
    expect(runRecovery).toHaveBeenCalledTimes(1);

    finishFirst(emptyRecoveryResult());
    await Promise.all([active, trailing]);

    expect(runRecovery).toHaveBeenCalledTimes(2);
    expect(runRecovery.mock.calls.map(([source]) => source)).toEqual(["startup", "subagent-ended"]);
  });

  it("continues recovery even when terminal cleanup fails", async () => {
    const runRecovery = vi.fn().mockResolvedValue(emptyRecoveryResult());
    const settleTerminatedRun = vi.fn().mockResolvedValue({ status: "already-terminal" });
    const cleanupRun = vi.fn().mockRejectedValue(new Error("cleanup exploded"));
    const logger = createLogger();
    const controller = createWorkboardRecoveryController({
      runRecovery,
      settleTerminatedRun,
      cleanupRun,
      logger,
    });
    const event = {
      targetSessionKey: "agent:main:subagent:cleanup",
      runId: "run-cleanup",
      outcome: "ok" as const,
    };

    await controller.handleSubagentEnded(event, true);

    expect(settleTerminatedRun).toHaveBeenCalledWith(event);
    expect(cleanupRun).toHaveBeenCalledWith(event);
    expect(runRecovery).toHaveBeenCalledWith("subagent-ended");
    expect(logger.warn).toHaveBeenCalledWith(
      "workboard run cleanup failed",
      expect.objectContaining({ error: "cleanup exploded" }),
    );
  });

  it("projects a completion-owned terminal event before local recovery is enabled", async () => {
    const runRecovery = vi.fn().mockResolvedValue(emptyRecoveryResult());
    const settleTerminatedRun = vi.fn().mockResolvedValue({ status: "completion-owned" });
    const cleanupRun = vi.fn();
    const controller = createWorkboardRecoveryController({
      runRecovery,
      settleTerminatedRun,
      cleanupRun,
      logger: createLogger(),
    });
    const event = {
      targetSessionKey: "agent:main:subagent:completion-owned",
      runId: "run-completion-owned",
      outcome: "error" as const,
      error: "Agent run failed",
    };

    await controller.handleSubagentEnded(event, false);

    expect(settleTerminatedRun).toHaveBeenCalledWith(event);
    expect(cleanupRun).not.toHaveBeenCalled();
    expect(runRecovery).toHaveBeenCalledWith("subagent-ended");
  });

  it("retries a rejected terminal settlement before cleaning up", async () => {
    const runRecovery = vi.fn().mockResolvedValue(emptyRecoveryResult());
    const settleTerminatedRun = vi
      .fn()
      .mockRejectedValueOnce(new Error("sqlite busy"))
      .mockResolvedValue({ status: "settled" });
    const cleanupRun = vi.fn().mockResolvedValue(undefined);
    const controller = createWorkboardRecoveryController({
      runRecovery,
      settleTerminatedRun,
      cleanupRun,
      logger: createLogger(),
    });
    const event = {
      targetSessionKey: "agent:main:subagent:settle-retry",
      runId: "run-settle-retry",
      outcome: "error" as const,
      error: "worker failed",
    };

    await controller.handleSubagentEnded(event, false);

    expect(settleTerminatedRun).toHaveBeenCalledTimes(2);
    expect(cleanupRun).toHaveBeenCalledTimes(1);
    expect(cleanupRun).toHaveBeenCalledWith(event);
  });

  it("queues the exact terminal event when one settlement pass exhausts its CAS retries", async () => {
    vi.useFakeTimers();
    const runRecovery = vi.fn().mockResolvedValue(emptyRecoveryResult());
    const settleTerminatedRun = vi
      .fn()
      .mockResolvedValueOnce({ status: "retry-exhausted", error: "revision churn" })
      .mockResolvedValueOnce({ status: "retry-exhausted", error: "revision churn" })
      .mockResolvedValueOnce({ status: "retry-exhausted", error: "revision churn" })
      .mockResolvedValue({ status: "settled" });
    const cleanupRun = vi.fn().mockResolvedValue(undefined);
    const controller = createWorkboardRecoveryController({
      runRecovery,
      settleTerminatedRun,
      cleanupRun,
      logger: createLogger(),
      terminalRetryDelayMs: 25,
      maxTerminalRetryPasses: 2,
    });
    const event = {
      targetSessionKey: "agent:main:subagent:queued-terminal",
      runId: "run-queued-terminal",
      outcome: "error" as const,
      error: "worker failed",
    };

    await controller.handleSubagentEnded(event, false);
    expect(settleTerminatedRun).toHaveBeenCalledTimes(3);
    expect(cleanupRun).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(25);

    expect(settleTerminatedRun).toHaveBeenCalledTimes(4);
    expect(cleanupRun).toHaveBeenCalledTimes(1);
    expect(cleanupRun).toHaveBeenCalledWith(event);
  });

  it("uses one wake timer for startup, continuation, and any number of terminal retries", async () => {
    vi.useFakeTimers();
    const runRecovery = vi.fn().mockResolvedValue(emptyRecoveryResult({ needsContinuation: true }));
    const settleTerminatedRun = vi
      .fn()
      .mockResolvedValue({ status: "retry-exhausted", error: "revision churn" });
    const controller = createWorkboardRecoveryController({
      runRecovery,
      settleTerminatedRun,
      cleanupRun: vi.fn(),
      logger: createLogger(),
      continuationDelayMs: 25,
      terminalRetryDelayMs: 20,
      maxTerminalRetryPasses: 2,
    });

    controller.schedule("startup", 50);
    expect(vi.getTimerCount()).toBe(1);
    await controller.request("dispatch");
    expect(vi.getTimerCount()).toBe(1);
    for (let index = 0; index < 8; index += 1) {
      await controller.handleSubagentEnded(
        {
          targetSessionKey: `agent:main:subagent:${index}`,
          runId: `run-${index}`,
          outcome: "error",
          error: "worker failed",
        },
        false,
      );
      expect(vi.getTimerCount()).toBe(1);
    }
  });

  it.each([
    "gateway closed (1012): service restart",
    "codex app-server client closed before turn completed",
  ])("preserves restart-interrupted worktrees for recovery: %s", async (error) => {
    const runRecovery = vi.fn().mockResolvedValue(emptyRecoveryResult());
    const settleTerminatedRun = vi.fn();
    const cleanupRun = vi.fn();
    const controller = createWorkboardRecoveryController({
      runRecovery,
      settleTerminatedRun,
      cleanupRun,
      logger: createLogger(),
    });

    await controller.handleSubagentEnded(
      {
        targetSessionKey: "agent:main:subagent:restart",
        runId: "run-restart",
        outcome: "error",
        error,
      },
      false,
    );

    expect(settleTerminatedRun).not.toHaveBeenCalled();
    expect(cleanupRun).not.toHaveBeenCalled();
    expect(runRecovery).not.toHaveBeenCalled();
  });

  it("schedules bounded continuation passes when overflow cannot start", async () => {
    vi.useFakeTimers();
    const runRecovery = vi.fn().mockResolvedValue(emptyRecoveryResult({ needsContinuation: true }));
    const controller = createWorkboardRecoveryController({
      runRecovery,
      settleTerminatedRun: vi.fn(),
      cleanupRun: vi.fn(),
      logger: createLogger(),
      continuationDelayMs: 25,
      maxContinuationPasses: 2,
    });

    await controller.request("startup");
    expect(runRecovery).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(75);

    expect(runRecovery).toHaveBeenCalledTimes(3);
    expect(runRecovery.mock.calls.map(([source]) => source)).toEqual([
      "startup",
      "continuation",
      "continuation",
    ]);
  });

  it("retries a transient reconciliation failure within the continuation bound", async () => {
    vi.useFakeTimers();
    const runRecovery = vi
      .fn()
      .mockRejectedValueOnce(new Error("store still opening"))
      .mockResolvedValue(emptyRecoveryResult());
    const logger = createLogger();
    const controller = createWorkboardRecoveryController({
      runRecovery,
      settleTerminatedRun: vi.fn(),
      cleanupRun: vi.fn(),
      logger,
      continuationDelayMs: 25,
      maxContinuationPasses: 2,
    });

    await controller.request("startup");
    expect(runRecovery).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "workboard interrupted-run reconciliation failed",
      expect.objectContaining({ source: "startup", error: "store still opening" }),
    );

    await vi.advanceTimersByTimeAsync(25);

    expect(runRecovery).toHaveBeenCalledTimes(2);
    expect(runRecovery.mock.calls.map(([source]) => source)).toEqual(["startup", "continuation"]);
  });

  it("keeps retrying reconciliation exceptions beyond the bounded continuation cap", async () => {
    vi.useFakeTimers();
    const runRecovery = vi
      .fn()
      .mockRejectedValueOnce(new Error("store opening 1"))
      .mockRejectedValueOnce(new Error("store opening 2"))
      .mockRejectedValueOnce(new Error("store opening 3"))
      .mockRejectedValueOnce(new Error("store opening 4"))
      .mockRejectedValueOnce(new Error("store opening 5"))
      .mockResolvedValue(emptyRecoveryResult());
    const controller = createWorkboardRecoveryController({
      runRecovery,
      settleTerminatedRun: vi.fn(),
      cleanupRun: vi.fn(),
      logger: createLogger(),
      continuationDelayMs: 10,
      durableContinuationMaxDelayMs: 40,
      maxContinuationPasses: 1,
    });

    await controller.request("startup");
    await vi.advanceTimersByTimeAsync(160);

    expect(runRecovery).toHaveBeenCalledTimes(6);
    expect(runRecovery.mock.calls.slice(1).every(([source]) => source === "continuation")).toBe(
      true,
    );
  });
});
