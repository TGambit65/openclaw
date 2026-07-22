import { formatErrorMessage } from "../infra/errors.js";
import {
  createQueuedTaskRun,
  createRunningTaskRun,
  finalizeTaskRunByRunId,
} from "../tasks/detached-task-runtime.js";
import { runTaskInFlowForOwner } from "../tasks/task-executor.js";
import { getTaskFlowById, resumeFlow } from "../tasks/task-flow-runtime-internal.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const MIN_TASK_GENERATION_RETRY_DELAY_MS = 1_000;
const MAX_TASK_GENERATION_RETRY_DELAY_MS = 60_000;

/** Keeps a missing successor task row from turning every lifecycle lookup into a write retry. */
export function resolveSubagentTaskGenerationRetryDelayMs(attemptCount: number): number {
  const boundedAttemptCount = Math.max(1, Math.min(attemptCount, 10));
  return Math.min(
    MIN_TASK_GENERATION_RETRY_DELAY_MS * 2 ** (boundedAttemptCount - 1),
    MAX_TASK_GENERATION_RETRY_DELAY_MS,
  );
}

/** A pending successor always owns terminal task mutations, even before its task row exists. */
export function resolveOwnedSubagentTaskRunId(entry: SubagentRunRecord): string {
  return entry.taskGenerationRecovery?.runId ?? entry.taskRunId ?? entry.runId;
}

export function prepareRecoveredSubagentParentFlow(
  previousTask: TaskRecord | undefined,
  startedAt: number,
): void {
  const flowId = previousTask?.parentFlowId?.trim();
  if (!flowId) {
    return;
  }
  let flow = getTaskFlowById(flowId);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!flow) {
      throw new Error(`parent task flow is unavailable: ${flowId}`);
    }
    if (flow.cancelRequestedAt != null) {
      throw new Error(`parent task flow cancellation was already requested: ${flowId}`);
    }
    const shouldResume =
      flow.status === "failed" ||
      flow.status === "lost" ||
      (flow.controllerId === "workboard" &&
        (flow.status === "waiting" || flow.status === "blocked"));
    if (!shouldResume) {
      return;
    }
    const resumed = resumeFlow({
      flowId,
      expectedRevision: flow.revision,
      status: "running",
      currentStep: flow.currentStep,
      stateJson: flow.stateJson,
      updatedAt: startedAt,
    });
    if (resumed.applied) {
      return;
    }
    if (resumed.reason !== "revision_conflict") {
      throw new Error(`failed to resume parent task flow: ${flowId} (${resumed.reason})`);
    }
    flow = resumed.current;
  }
  throw new Error(`parent task flow kept changing during recovery: ${flowId}`);
}

function terminalizeRecoveredPredecessor(params: {
  previousTask: TaskRecord | undefined;
  childSessionKey: string;
  endedAt: number;
}): void {
  const previousTask = params.previousTask;
  if (!previousTask || (previousTask.status !== "queued" && previousTask.status !== "running")) {
    return;
  }
  const runId = previousTask.runId?.trim();
  if (!runId) {
    throw new Error("recovery predecessor task has no exact run id");
  }
  const finalized = finalizeTaskRunByRunId({
    runId,
    runtime: "subagent",
    sessionKey: params.childSessionKey,
    status: "failed",
    endedAt: params.endedAt,
    lastEventAt: params.endedAt,
    error: "Subagent run was replaced during restart recovery.",
    suppressDelivery: true,
  }).find((task) => task.taskId === previousTask.taskId);
  if (!finalized || finalized.status === "queued" || finalized.status === "running") {
    throw new Error("failed to terminalize the recovery predecessor task");
  }
}

export function tryCreateRecoveredSubagentTaskGeneration(params: {
  entry: SubagentRunRecord;
  runId: string;
  task: string;
  startedAt: number;
  previousTask?: TaskRecord;
  status?: "queued" | "running";
}): { task: TaskRecord; error?: undefined } | { task: null; error: string } {
  const runId = params.runId.trim();
  try {
    // Recovery transfers execution ownership to a fresh run generation. Close
    // the interrupted task first so a crash before successor creation cannot
    // leave both generations counted as active.
    terminalizeRecoveredPredecessor({
      previousTask: params.previousTask,
      childSessionKey: params.entry.childSessionKey,
      endedAt: params.startedAt,
    });
    prepareRecoveredSubagentParentFlow(params.previousTask, params.startedAt);
    const status = params.status ?? "running";
    const common = {
      runtime: "subagent",
      taskKind: params.previousTask?.taskKind,
      sourceId: runId,
      requesterSessionKey:
        params.previousTask?.requesterSessionKey ?? params.entry.requesterSessionKey,
      ownerKey: params.previousTask?.ownerKey ?? params.entry.requesterSessionKey,
      scopeKind: params.previousTask?.scopeKind ?? "session",
      requesterOrigin: params.entry.requesterOrigin,
      parentFlowId: params.previousTask?.parentFlowId,
      childSessionKey: params.entry.childSessionKey,
      parentTaskId: params.previousTask?.parentTaskId,
      agentId: params.previousTask?.agentId,
      requesterAgentId: params.previousTask?.requesterAgentId,
      runId,
      label: params.entry.label,
      task: params.task,
      notifyPolicy: params.previousTask?.notifyPolicy,
      deliveryStatus:
        params.entry.expectsCompletionMessage === false ? "not_applicable" : "pending",
    } as const;
    const parentFlowId = params.previousTask?.parentFlowId?.trim();
    const parentFlow = parentFlowId ? getTaskFlowById(parentFlowId) : undefined;
    const task =
      parentFlowId && parentFlow?.syncMode === "managed"
        ? (runTaskInFlowForOwner({
            flowId: parentFlowId,
            callerOwnerKey: params.previousTask?.ownerKey ?? params.entry.requesterSessionKey,
            ...common,
            status,
            ...(status === "running"
              ? { startedAt: params.startedAt, lastEventAt: params.startedAt }
              : {}),
          }).task ?? null)
        : status === "running"
          ? createRunningTaskRun({
              ...common,
              startedAt: params.startedAt,
              lastEventAt: params.startedAt,
            })
          : createQueuedTaskRun(common);
    if (!task) {
      return { task: null, error: "task runtime returned no durable task" };
    }
    if (task.runId?.trim() !== runId || task.status !== status) {
      return {
        task: null,
        error: `task runtime returned a mismatched or non-${status} task generation`,
      };
    }
    return { task };
  } catch (error) {
    return { task: null, error: formatErrorMessage(error) };
  }
}
