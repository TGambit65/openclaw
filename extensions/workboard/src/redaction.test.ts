import { describe, expect, it } from "vitest";
import { redactWorkboardCardForExternalView } from "./redaction.js";
import type { WorkboardCard } from "./types.js";

describe("Workboard external redaction", () => {
  it("retains the durable route internally but removes it from card and completion projections", () => {
    const card = {
      id: "card-route",
      title: "Private requester route",
      status: "review",
      priority: "normal",
      position: 1,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        automation: {
          requesterSessionKey: "agent:main:telegram:direct:user-123",
          requesterOrigin: {
            channel: "telegram",
            to: "telegram-chat-123",
            accountId: "private-account",
            threadId: 42,
          },
          requesterWorkspace: "/private/requester/workspace",
          flowOwnerSessionKey: "agent:main:telegram:direct:user-123",
          completionDelivery: {
            kind: "verified_workboard_completion",
            obligationId: "obligation-1",
            cardId: "card-route",
            sessionKey: "agent:main:subagent:worker",
            runId: "run-1",
            expectedRunId: "run-1",
            expectedRevision: "revision-1",
            claimOwnerId: "worker",
            requesterSessionKey: "agent:main:telegram:direct:user-123",
            requesterOrigin: { channel: "telegram", to: "telegram-chat-123" },
            summary: "done",
            completionText: "done",
            proof: { id: "proof", status: "passed", createdAt: 1 },
            artifacts: [
              {
                id: "artifact",
                createdAt: 1,
                path: "/durable/result",
                byteSize: 1,
                sha256: "a".repeat(64),
                verifiedAt: 1,
              },
            ],
            payloadHash: "b".repeat(64),
            acceptedAt: 1,
            status: "pending",
            flowId: "flow-1",
            flowOwnerSessionKey: "agent:main:main",
            flowRevision: 1,
            controllerId: "workboard",
          },
        },
      },
    } as unknown as WorkboardCard;

    const external = redactWorkboardCardForExternalView(card);

    expect(card.metadata?.automation?.requesterOrigin?.to).toBe("telegram-chat-123");
    expect(JSON.stringify(external)).not.toContain("telegram-chat-123");
    expect(JSON.stringify(external)).not.toContain("private-account");
    expect(JSON.stringify(external)).not.toContain("agent:main:telegram:direct:user-123");
    expect(JSON.stringify(external)).not.toContain("agent:main:main");
    expect(JSON.stringify(external)).not.toContain("/private/requester/workspace");
    expect(external.metadata?.automation?.completionDelivery).toMatchObject({
      obligationId: "obligation-1",
      status: "pending",
    });
  });
});
