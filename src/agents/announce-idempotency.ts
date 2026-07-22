/**
 * Stable announce identifiers for child-run completion messages.
 * Versioned keys let future formats coexist with persisted v1 delivery records.
 */
import { createHash } from "node:crypto";

type AnnounceIdFromChildRunParams = {
  childSessionKey: string;
  childRunId: string;
};

/** Build the persisted announce id for a child session/run pair. */
export function buildAnnounceIdFromChildRun(params: AnnounceIdFromChildRunParams): string {
  return `v1:${params.childSessionKey}:${params.childRunId}`;
}

/**
 * Build an obligation-specific id for an immutable verified completion.
 * Hashing keeps caller-supplied keys bounded and out of delivery metadata.
 */
export function buildAnnounceIdFromCompletionObligation(
  params: AnnounceIdFromChildRunParams & { obligationId: string },
): string {
  const obligationHash = createHash("sha256").update(params.obligationId).digest("hex");
  return `v2:${params.childSessionKey}:${params.childRunId}:${obligationHash}`;
}

/** Build the idempotency key used by announce delivery storage. */
export function buildAnnounceIdempotencyKey(announceId: string): string {
  return `announce:${announceId}`;
}
