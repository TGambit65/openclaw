// Workboard plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "./api.js";
import { registerWorkboardGatewayMethods } from "./runtime-api.js";
import { registerWorkboardCommand } from "./src/command.js";
import {
  completeWorkboardCardWithDelivery,
  readWorkboardManagedFlow,
  reconcileWorkboardCompletionDeliveries,
  type WorkboardCompletionCoordinator,
} from "./src/completion-delivery.js";
import {
  cleanupWorkboardRunWorktree,
  reconcileInterruptedWorkboardCards,
  settleTerminatedWorkboardRun,
} from "./src/dispatcher.js";
import { createWorkboardRecoveryController } from "./src/recovery-controller.js";
import { WorkboardStore } from "./src/store.js";
import { createWorkboardTools } from "./src/tools.js";

// Reconcile promptly, but never take local retry ownership until core reports
// that its persisted restart-recovery budget is explicitly exhausted.
const STARTUP_RECONCILIATION_DELAY_MS = 1_000;

export default definePluginEntry({
  id: "workboard",
  name: "Workboard",
  description: "Dashboard workboard for agent-owned issues and sessions.",
  register(api) {
    const store = WorkboardStore.openSqlite();
    let recoveryEnabled = false;
    const recoveryController = createWorkboardRecoveryController({
      runRecovery: async () => {
        // The core outbox is delivery authority. Project it before ordinary
        // restart recovery so one controller and one continuation timer own
        // every Workboard retry.
        const completion = await reconcileWorkboardCompletionDeliveries({
          store,
          subagent: api.runtime.subagent,
          taskFlow: api.runtime.tasks.managedFlows,
          onDelivered: async (_card, intent) => {
            const cleaned = await cleanupWorkboardRunWorktree({
              store,
              worktrees: api.runtime.worktrees,
              runId: intent.runId,
              sessionKey: intent.childSessionKey,
            });
            if (!cleaned) {
              throw new Error("verified completion worktree could not be removed losslessly");
            }
          },
          logger: api.logger,
        });
        const recovery = await reconcileInterruptedWorkboardCards({
          store,
          subagent: api.runtime.subagent,
          managedFlows: api.runtime.tasks.managedFlows,
          sessions: api.runtime.agent.session,
          worktrees: api.runtime.worktrees,
          options: { allowManagedWorktrees: true },
        });
        return {
          ...recovery,
          needsContinuation: recovery.needsContinuation || completion.needsContinuation,
          ...(completion.needsContinuation ? { continuationMode: "durable" as const } : {}),
        };
      },
      settleTerminatedRun: async (event) =>
        await settleTerminatedWorkboardRun({
          store,
          subagent: api.runtime.subagent,
          event,
        }),
      cleanupRun: async (event) =>
        await (async () => {
          if (event.runId) {
            const state = await api.runtime.subagent.getRunState({
              sessionKey: event.targetSessionKey,
              runId: event.runId,
            });
            if (
              state.verifiedCompletionIntent &&
              (state.status !== "terminal" || state.deliveryStatus !== "delivered")
            ) {
              return;
            }
          }
          const cleaned = await cleanupWorkboardRunWorktree({
            store,
            worktrees: api.runtime.worktrees,
            runId: event.runId,
            sessionKey: event.targetSessionKey,
          });
          if (!cleaned) {
            throw new Error("Workboard worktree could not be removed losslessly");
          }
        })(),
      logger: api.logger,
    });
    const completeCard: WorkboardCompletionCoordinator = async (id, input, scope) => {
      const projected = await completeWorkboardCardWithDelivery({
        store,
        subagent: api.runtime.subagent,
        taskFlow: api.runtime.tasks.managedFlows,
        id,
        input,
        scope,
      });
      await recoveryController.request("dispatch");
      return (await store.get(id)) ?? projected;
    };
    const requestDispatchReconciliation = async (): Promise<void> => {
      await recoveryController.request("dispatch");
    };
    registerWorkboardGatewayMethods({
      api,
      store,
      onReconciliationNeeded: requestDispatchReconciliation,
      completeCard,
      readManagedFlow: (card) => readWorkboardManagedFlow(card, api.runtime.tasks.managedFlows),
    });
    registerWorkboardCommand({
      api,
      store,
      onReconciliationNeeded: requestDispatchReconciliation,
    });
    api.on("gateway_start", () => {
      recoveryEnabled = true;
      recoveryController.schedule("startup", STARTUP_RECONCILIATION_DELAY_MS);
    });
    api.on("subagent_ended", async (event) => {
      await recoveryController.handleSubagentEnded(event, recoveryEnabled);
    });
    api.registerCli(
      async ({ program }) => {
        const { registerWorkboardCli } = await import("./src/cli.js");
        registerWorkboardCli({ program, store });
      },
      {
        descriptors: [
          {
            name: "workboard",
            description: "Manage Workboard cards and worker dispatch",
            hasSubcommands: true,
          },
        ],
      },
    );
    api.registerTool(
      (context) =>
        createWorkboardTools({
          api,
          context,
          store,
          completeCard,
          readManagedFlow: (card) => readWorkboardManagedFlow(card, api.runtime.tasks.managedFlows),
          onReconciliationNeeded: requestDispatchReconciliation,
        }),
      {
        names: [
          "workboard_list",
          "workboard_create",
          "workboard_link",
          "workboard_read",
          "workboard_claim",
          "workboard_heartbeat",
          "workboard_complete",
          "workboard_attachment_add",
          "workboard_attachment_read",
          "workboard_attachment_delete",
          "workboard_block",
          "workboard_boards",
          "workboard_board_create",
          "workboard_board_archive",
          "workboard_board_delete",
          "workboard_stats",
          "workboard_runs",
          "workboard_specify",
          "workboard_decompose",
          "workboard_notify_subscribe",
          "workboard_notify_list",
          "workboard_notify_events",
          "workboard_notify_advance",
          "workboard_notify_unsubscribe",
          "workboard_promote",
          "workboard_reassign",
          "workboard_reclaim",
          "workboard_dispatch",
          "workboard_release",
          "workboard_comment",
          "workboard_proof",
          "workboard_worker_log",
          "workboard_protocol_violation",
          "workboard_unblock",
        ],
        optional: true,
      },
    );
  },
});
