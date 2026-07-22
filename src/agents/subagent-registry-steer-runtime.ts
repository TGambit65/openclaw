/**
 * Late-bound steer hooks for the subagent registry.
 *
 * Lets steer/recovery code depend on a small module while the full registry installs concrete mutation hooks.
 */
import type {
  SubagentOrphanRecoveryClaimResult,
  SubagentRunRecord,
} from "./subagent-registry.types.js";

type ReplaceSubagentRunAfterSteerParams = {
  previousRunId: string;
  nextRunId: string;
  fallback?: SubagentRunRecord;
  runTimeoutSeconds?: number;
  preserveFrozenResultFallback?: boolean;
  /** Return success only after the replacement registry generation commits durably. */
  requireDurableReplacement?: boolean;
  /** Create and relink a fresh durable task attempt for restart recovery. */
  createFreshTaskGeneration?: boolean;
  /** The recovery controller already admitted and started the exact task attempt. */
  taskGenerationAlreadyCreated?: boolean;
  transcriptFile?: string;
  /**
   * Optional task override for the replacement run.  Callers that dispatched a
   * new message (steer, descendant wake, orphan resume) should pass the text
   * actually sent so that restart-redispatch reconstructs the correct prompt
   * after a gateway crash.  When omitted, the previous run's `task` is carried
   * over untouched.
   */
  task?: string;
};

type ReplaceSubagentRunAfterSteerFn = (params: ReplaceSubagentRunAfterSteerParams) => boolean;

type FinalizeInterruptedSubagentRunParams = {
  runId?: string;
  childSessionKey?: string;
  error: string;
  endedAt?: number;
};

type FinalizeInterruptedSubagentRunFn = (
  params: FinalizeInterruptedSubagentRunParams,
) => Promise<number>;

type ClaimSubagentOrphanRecoveryParams = {
  predecessorRunId: string;
  childSessionKey: string;
  successorRunId: string;
  claimedAt?: number;
};

type SettleSubagentOrphanRecoveryParams = {
  predecessorRunId: string;
  childSessionKey: string;
  error?: string;
  settledAt?: number;
};

let replaceSubagentRunAfterSteerImpl: ReplaceSubagentRunAfterSteerFn | null = null;
let finalizeInterruptedSubagentRunImpl: FinalizeInterruptedSubagentRunFn | null = null;
let claimSubagentOrphanRecoveryImpl:
  | ((params: ClaimSubagentOrphanRecoveryParams) => SubagentOrphanRecoveryClaimResult)
  | null = null;
let markSubagentOrphanRecoveryDeclinedImpl:
  | ((params: SettleSubagentOrphanRecoveryParams) => boolean)
  | null = null;
let markSubagentOrphanRecoveryExhaustedImpl:
  | ((params: SettleSubagentOrphanRecoveryParams) => boolean)
  | null = null;

/** Installs registry mutation hooks used by steer/recovery runtime paths. */
export function configureSubagentRegistrySteerRuntime(params: {
  replaceSubagentRunAfterSteer: ReplaceSubagentRunAfterSteerFn;
  finalizeInterruptedSubagentRun?: FinalizeInterruptedSubagentRunFn;
  claimSubagentOrphanRecovery?: (
    params: ClaimSubagentOrphanRecoveryParams,
  ) => SubagentOrphanRecoveryClaimResult;
  markSubagentOrphanRecoveryDeclined?: (params: SettleSubagentOrphanRecoveryParams) => boolean;
  markSubagentOrphanRecoveryExhausted?: (params: SettleSubagentOrphanRecoveryParams) => boolean;
}) {
  replaceSubagentRunAfterSteerImpl = params.replaceSubagentRunAfterSteer;
  finalizeInterruptedSubagentRunImpl = params.finalizeInterruptedSubagentRun ?? null;
  claimSubagentOrphanRecoveryImpl = params.claimSubagentOrphanRecovery ?? null;
  markSubagentOrphanRecoveryDeclinedImpl = params.markSubagentOrphanRecoveryDeclined ?? null;
  markSubagentOrphanRecoveryExhaustedImpl = params.markSubagentOrphanRecoveryExhausted ?? null;
}

/** Replaces a previous run id after steering, returning false when no hook is installed. */
export function replaceSubagentRunAfterSteer(params: ReplaceSubagentRunAfterSteerParams) {
  return replaceSubagentRunAfterSteerImpl?.(params) ?? false;
}

/** Finalizes interrupted runs through the installed registry hook. */
export async function finalizeInterruptedSubagentRun(params: FinalizeInterruptedSubagentRunParams) {
  return (await finalizeInterruptedSubagentRunImpl?.(params)) ?? 0;
}

export function claimSubagentOrphanRecovery(
  params: ClaimSubagentOrphanRecoveryParams,
): SubagentOrphanRecoveryClaimResult {
  return (
    claimSubagentOrphanRecoveryImpl?.(params) ?? {
      status: "unavailable",
      error: "subagent registry recovery ownership is unavailable",
    }
  );
}

export function markSubagentOrphanRecoveryDeclined(
  params: SettleSubagentOrphanRecoveryParams,
): boolean {
  return markSubagentOrphanRecoveryDeclinedImpl?.(params) ?? false;
}

export function markSubagentOrphanRecoveryExhausted(
  params: SettleSubagentOrphanRecoveryParams,
): boolean {
  return markSubagentOrphanRecoveryExhaustedImpl?.(params) ?? false;
}
