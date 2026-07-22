// Plugin runtime types describe activated plugin capabilities exposed to core execution.
import type { OperatorScope } from "../../gateway/operator-scopes.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { PluginRuntimeCore, RuntimeLogger } from "./types-core.js";

export type { RuntimeLogger };

type PluginRuntimeChannel = import("./types-channel.js").PluginRuntimeChannel;

// ── Subagent runtime types ──────────────────────────────────────────

export type SubagentRunParams = {
  sessionKey: string;
  message: string;
  provider?: string;
  model?: string;
  extraSystemPrompt?: string;
  lane?: string;
  lightContext?: boolean;
  deliver?: boolean;
  idempotencyKey?: string;
  cwd?: string;
  parentFlowId?: string;
  flowOwnerSessionKey?: string;
};

export type PluginManagedWorktree = {
  id: string;
  path: string;
  branch: string;
};

export type SubagentRunResult = {
  runId: string;
};

export type SubagentWaitParams = {
  runId: string;
  timeoutMs?: number;
};

export type SubagentWaitResult = {
  status: "ok" | "error" | "timeout";
  error?: string;
};

export type SubagentRecoveryOwnershipParams = {
  sessionKey: string;
  runId: string;
};

export type SubagentRecoveryOwnershipResult = {
  status: "unknown" | "core_owned" | "successor" | "exhausted";
  successorRunId?: string;
  error?: string;
};

export type SubagentResolveOwnerSessionParams = {
  sessionKey: string;
};

export type SubagentResolveOwnerSessionResult =
  | {
      status: "resolved";
      workerSessionKey: string;
      ownerSessionKey: string;
      workspaceDir: string;
    }
  | { status: "unknown" };

export type SubagentRunStateParams = {
  sessionKey: string;
  runId: string;
};

export type SubagentVerifiedCompletionProof = {
  id: string;
  status: "passed";
  createdAt: number;
  label?: string;
  command?: string;
  url?: string;
  note?: string;
};

export type SubagentVerifiedCompletionArtifact = {
  id: string;
  createdAt: number;
  path: string;
  byteSize: number;
  sha256: string;
  verifiedAt: number;
  label?: string;
  url?: string;
  mimeType?: string;
};

export type SubagentVerifiedCompletionIntent = {
  kind: "verified_workboard_completion";
  obligationId: string;
  payloadHash: string;
  acceptedAt: number;
  cardId: string;
  childSessionKey: string;
  runId: string;
  expectedRunId: string;
  expectedRevision: string;
  claimOwnerId: string;
  summary: string;
  completionText: string;
  proof: SubagentVerifiedCompletionProof;
  artifacts: SubagentVerifiedCompletionArtifact[];
  createdCardIds: string[];
  flowId: string;
  flowOwnerSessionKey: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  flowRevision: number;
  controllerId: "workboard";
};

export type SubagentRequireCompletionDeliveryParams = {
  sessionKey: string;
  runId: string;
  idempotencyKey: string;
  cardId: string;
  expectedRunId: string;
  expectedRevision: string;
  claimOwnerId: string;
  summary: string;
  completionText: string;
  proof: SubagentVerifiedCompletionProof;
  artifacts: SubagentVerifiedCompletionArtifact[];
  createdCardIds: string[];
  flowId: string;
  flowOwnerSessionKey: string;
  flowRevision: number;
  controllerId: "workboard";
};

export type SubagentCompletionDeliveryStatus =
  | "not_required"
  | "pending"
  | "in_progress"
  | "delivered"
  | "failed"
  | "suspended"
  | "discarded";

export type SubagentRequireCompletionDeliveryResult =
  | {
      status: "armed" | "already_armed" | "delivered";
      deliveryStatus: SubagentCompletionDeliveryStatus;
      deliveredAt?: number;
      verifiedCompletionIntent: SubagentVerifiedCompletionIntent;
    }
  | { status: "unknown"; error?: string };

export type SubagentRunStateResult = {
  status: "unknown" | "absent" | "active" | "terminal";
  outcome?: "ok" | "error" | "timeout" | "killed";
  error?: string;
  deliveryStatus?: SubagentCompletionDeliveryStatus;
  deliveredAt?: number;
  deliveryError?: string;
  discardReason?: "expired" | "pressure-pruned";
  deliveryObligationId?: string;
  verifiedCompletionIntent?: SubagentVerifiedCompletionIntent;
};

export type SubagentGetSessionMessagesParams = {
  sessionKey: string;
  limit?: number;
};

export type SubagentGetSessionMessagesResult = {
  messages: unknown[];
};

/** @deprecated Use SubagentGetSessionMessagesParams. */
export type SubagentGetSessionParams = SubagentGetSessionMessagesParams;

/** @deprecated Use SubagentGetSessionMessagesResult. */
export type SubagentGetSessionResult = SubagentGetSessionMessagesResult;

export type SubagentDeleteSessionParams = {
  sessionKey: string;
  deleteTranscript?: boolean;
};

export type RuntimeNodeListParams = {
  connected?: boolean;
};

export type RuntimeNodeListResult = {
  nodes: Array<{
    nodeId: string;
    displayName?: string;
    remoteIp?: string;
    connected?: boolean;
    caps?: string[];
    commands?: string[];
  }>;
};

export type RuntimeNodeInvokeParams = {
  nodeId: string;
  command: string;
  params?: unknown;
  timeoutMs?: number;
  idempotencyKey?: string;
  /** Requested Gateway scopes. Honored only for bundled or trusted official plugins. */
  scopes?: OperatorScope[];
};

export type RuntimeGatewayRequestOptions = {
  timeoutMs?: number;
};

/** Trusted in-process runtime surface injected into native plugins. */
export type PluginRuntime = PluginRuntimeCore & {
  gateway: {
    /** Whether this process owns an active Gateway request context. */
    isAvailable: () => Promise<boolean>;
    /** Dispatch a Gateway method as the current trusted plugin. */
    request: <T = unknown>(
      method: string,
      params?: Record<string, unknown>,
      options?: RuntimeGatewayRequestOptions,
    ) => Promise<T>;
  };
  subagent: {
    run: (params: SubagentRunParams) => Promise<SubagentRunResult>;
    resolveOwnerSession: (
      params: SubagentResolveOwnerSessionParams,
    ) => Promise<SubagentResolveOwnerSessionResult>;
    waitForRun: (params: SubagentWaitParams) => Promise<SubagentWaitResult>;
    getRecoveryOwnership: (
      params: SubagentRecoveryOwnershipParams,
    ) => Promise<SubagentRecoveryOwnershipResult>;
    getRunState: (params: SubagentRunStateParams) => Promise<SubagentRunStateResult>;
    requireCompletionDelivery: (
      params: SubagentRequireCompletionDeliveryParams,
    ) => Promise<SubagentRequireCompletionDeliveryResult>;
    getSessionMessages: (
      params: SubagentGetSessionMessagesParams,
    ) => Promise<SubagentGetSessionMessagesResult>;
    /** @deprecated Use getSessionMessages. */
    getSession: (params: SubagentGetSessionParams) => Promise<SubagentGetSessionResult>;
    deleteSession: (params: SubagentDeleteSessionParams) => Promise<void>;
  };
  nodes: {
    list: (params?: RuntimeNodeListParams) => Promise<RuntimeNodeListResult>;
    invoke: (params: RuntimeNodeInvokeParams) => Promise<unknown>;
  };
  worktrees: {
    create: (params: {
      repoRoot: string;
      name: string;
      baseRef?: string;
      ownerKind: "workboard";
      ownerId: string;
    }) => Promise<PluginManagedWorktree>;
    release: (params: { path: string }) => Promise<void>;
    removeIfLossless: (params: { path: string }) => Promise<boolean>;
  };
  channel: PluginRuntimeChannel;
};

export type CreatePluginRuntimeOptions = {
  subagent?: PluginRuntime["subagent"];
  nodes?: PluginRuntime["nodes"];
  allowGatewaySubagentBinding?: boolean;
};
