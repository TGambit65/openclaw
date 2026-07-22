// Canonical session identity shared by the trusted plugin runtime preflight and
// the gateway dispatch boundary. Keeping both paths on resolveSessionStoreKey
// prevents Workboard from persisting a bare key that core later canonicalizes.
import {
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
  resolveMainSessionKey,
} from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionStoreKey } from "./session-store-key.js";

export type PluginSubagentSessionIdentity = {
  workerSessionKey: string;
  ownerSessionKey: string;
};

export function resolvePluginSubagentSessionIdentity(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): PluginSubagentSessionIdentity | undefined {
  const workerSessionKey = resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  }).trim();
  if (!workerSessionKey || workerSessionKey === "unknown") {
    return undefined;
  }
  const ownerSessionKey =
    params.cfg.session?.scope === "global" || workerSessionKey === "global"
      ? resolveMainSessionKey(params.cfg)
      : resolveAgentMainSessionKey({
          cfg: params.cfg,
          agentId: resolveAgentIdFromSessionKey(workerSessionKey),
        });
  if (!ownerSessionKey.trim()) {
    return undefined;
  }
  return { workerSessionKey, ownerSessionKey };
}
