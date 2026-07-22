// External Workboard projections must not reveal claim credentials or delivery routes.
import type { WorkboardCard } from "./types.js";

export function redactWorkboardCardForExternalView(card: WorkboardCard): WorkboardCard {
  const automation = card.metadata?.automation;
  const completionDelivery = automation?.completionDelivery;
  const safeCompletionDelivery = completionDelivery ? { ...completionDelivery } : undefined;
  if (safeCompletionDelivery) {
    delete (safeCompletionDelivery as unknown as Record<string, unknown>).requesterSessionKey;
    delete (safeCompletionDelivery as unknown as Record<string, unknown>).requesterOrigin;
    delete (safeCompletionDelivery as unknown as Record<string, unknown>).flowOwnerSessionKey;
  }
  const safeAutomation = automation
    ? (() => {
        const {
          requesterSessionKey: _requesterSessionKey,
          requesterOwnerMode: _requesterOwnerMode,
          requesterOrigin: _requesterOrigin,
          requesterWorkspace: _requesterWorkspace,
          flowOwnerSessionKey: _flowOwnerSessionKey,
          ...safe
        } = automation;
        return {
          ...safe,
          ...(safeCompletionDelivery ? { completionDelivery: safeCompletionDelivery } : {}),
        };
      })()
    : undefined;
  const claim = card.metadata?.claim;
  if (!automation && !claim) {
    return card;
  }
  return {
    ...card,
    metadata: {
      ...card.metadata,
      ...(safeAutomation ? { automation: safeAutomation } : {}),
      ...(claim ? { claim: { ...claim, token: "[redacted]" } } : {}),
    },
  };
}
