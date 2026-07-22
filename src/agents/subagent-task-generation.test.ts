import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createManagedTaskFlow,
  getTaskFlowById,
  resetTaskFlowRegistryForTests,
} from "../tasks/task-flow-registry.js";
import { configureTaskFlowRegistryRuntime } from "../tasks/task-flow-registry.store.js";
import { listTaskRecords, resetTaskRegistryForTests } from "../tasks/task-registry.js";
import { configureTaskRegistryRuntime } from "../tasks/task-registry.store.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { tryCreateRecoveredSubagentTaskGeneration } from "./subagent-task-generation.js";

const ownerKey = "agent:main:telegram:direct:kelly";
const childSessionKey = "agent:main:subagent:workboard-recovery";

function configureInMemoryTaskStores(): void {
  configureTaskRegistryRuntime({
    store: {
      loadSnapshot: () => ({ tasks: new Map(), deliveryStates: new Map() }),
      saveSnapshot: () => {},
      upsertTaskWithDeliveryState: () => {},
      upsertTask: () => {},
      deleteTaskWithDeliveryState: () => {},
      deleteTask: () => {},
      upsertDeliveryState: () => {},
      deleteDeliveryState: () => {},
    },
  });
  configureTaskFlowRegistryRuntime({
    store: {
      loadSnapshot: () => ({ flows: new Map() }),
      saveSnapshot: () => {},
      upsertFlow: () => {},
      deleteFlow: () => {},
    },
  });
}

beforeEach(() => {
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  configureInMemoryTaskStores();
});

afterEach(() => {
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
});

describe("recovered subagent task generation", () => {
  it("uses the requester-owned TaskFlow as the sole queued-attempt admission", () => {
    const flow = createManagedTaskFlow({
      ownerKey,
      requesterOrigin: { channel: "telegram", to: "kelly", accountId: "default" },
      controllerId: "workboard",
      goal: "Finish the interrupted Workboard card",
      status: "waiting",
    });
    expect(flow).not.toBeNull();
    const flowId = flow!.flowId;
    const previousTask: TaskRecord = {
      taskId: "previous-task",
      runtime: "subagent",
      requesterSessionKey: ownerKey,
      ownerKey,
      scopeKind: "session",
      requesterAgentId: "main",
      childSessionKey,
      parentFlowId: flowId,
      runId: "previous-run",
      label: "plugin:workboard",
      task: "Finish the card",
      status: "lost",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: 100,
    };
    const entry = {
      runId: "previous-run",
      childSessionKey,
      requesterSessionKey: ownerKey,
      requesterOrigin: { channel: "telegram", to: "kelly", accountId: "default" },
      requesterDisplayKey: "main",
      task: "Finish the card",
      cleanup: "keep",
      label: "plugin:workboard",
      expectsCompletionMessage: false,
      createdAt: 100,
    } satisfies SubagentRunRecord;

    const first = tryCreateRecoveredSubagentTaskGeneration({
      entry,
      runId: "successor-run",
      task: entry.task,
      startedAt: 200,
      previousTask,
      status: "queued",
    });
    const second = tryCreateRecoveredSubagentTaskGeneration({
      entry,
      runId: "successor-run",
      task: entry.task,
      startedAt: 201,
      previousTask,
      status: "queued",
    });

    expect(first.task).toMatchObject({
      runtime: "subagent",
      runId: "successor-run",
      childSessionKey,
      ownerKey,
      requesterSessionKey: ownerKey,
      parentFlowId: flowId,
      label: "plugin:workboard",
      status: "queued",
    });
    expect(second.task?.taskId).toBe(first.task?.taskId);
    expect(listTaskRecords().filter((task) => task.runId === "successor-run")).toHaveLength(1);
    expect(getTaskFlowById(flowId)).toMatchObject({ status: "running", ownerKey });
  });
});
