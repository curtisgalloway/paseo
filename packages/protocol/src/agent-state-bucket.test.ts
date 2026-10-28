import { describe, expect, it } from "vitest";
import {
  deriveAgentStateBucket,
  getAgentStatusPriority,
  getWorkspaceStateBucketPriority,
} from "./agent-state-bucket.js";

describe("deriveAgentStateBucket", () => {
  it("prioritizes pending permissions as needs_input", () => {
    expect(
      deriveAgentStateBucket({
        status: "idle",
        pendingPermissionCount: 1,
        requiresAttention: false,
        attentionReason: null,
      }),
    ).toBe("needs_input");
  });

  it("keeps legacy permission attention in needs_input", () => {
    expect(
      deriveAgentStateBucket({
        status: "idle",
        pendingPermissionCount: 0,
        requiresAttention: true,
        attentionReason: "permission",
      }),
    ).toBe("needs_input");
  });

  it("prioritizes error attention before running status", () => {
    expect(
      deriveAgentStateBucket({
        status: "running",
        pendingPermissionCount: 0,
        requiresAttention: true,
        attentionReason: "error",
      }),
    ).toBe("failed");
  });

  it("treats unread finished agents as attention", () => {
    expect(
      deriveAgentStateBucket({
        status: "idle",
        pendingPermissionCount: 0,
        requiresAttention: true,
        attentionReason: "finished",
      }),
    ).toBe("attention");
  });

  it("does not count initializing agents as running for workspace buckets", () => {
    expect(
      deriveAgentStateBucket({
        status: "initializing",
        pendingPermissionCount: 0,
        requiresAttention: false,
        attentionReason: null,
      }),
    ).toBe("done");
  });
});

describe("getWorkspaceStateBucketPriority", () => {
  it("orders active buckets before done", () => {
    expect(
      ["done", "attention", "running", "failed", "needs_input"].sort(
        (left, right) =>
          getWorkspaceStateBucketPriority(left) - getWorkspaceStateBucketPriority(right),
      ),
    ).toEqual(["needs_input", "failed", "running", "attention", "done"]);
  });
});

describe("getAgentStatusPriority", () => {
  it("keeps initializing agents ahead of completed agents in agent lists", () => {
    expect(getAgentStatusPriority({ status: "initializing" })).toBeLessThan(
      getAgentStatusPriority({ status: "idle" }),
    );
  });

  it("prioritizes pending permissions before errors and running agents", () => {
    const permission = getAgentStatusPriority({ status: "running", pendingPermissionCount: 1 });
    expect(permission).toBeLessThan(
      getAgentStatusPriority({ status: "error", pendingPermissionCount: 0 }),
    );
    expect(permission).toBeLessThan(
      getAgentStatusPriority({ status: "running", pendingPermissionCount: 0 }),
    );
  });
});

describe("awaitingInput", () => {
  it("shows an idle agent that asked a question as needs_input, even once read", () => {
    expect(
      deriveAgentStateBucket({ status: "idle", requiresAttention: false, awaitingInput: true }),
    ).toBe("needs_input");
    expect(
      deriveAgentStateBucket({
        status: "idle",
        requiresAttention: true,
        attentionReason: "finished",
        awaitingInput: true,
      }),
    ).toBe("needs_input");
  });

  it("lets running and failed outrank a stale question", () => {
    expect(deriveAgentStateBucket({ status: "running", awaitingInput: true })).toBe("running");
    expect(deriveAgentStateBucket({ status: "error", awaitingInput: true })).toBe("failed");
    expect(
      deriveAgentStateBucket({ status: "idle", attentionReason: "error", awaitingInput: true }),
    ).toBe("failed");
  });

  it("ranks a waiting agent with pending permissions in the agent list", () => {
    expect(getAgentStatusPriority({ status: "idle", awaitingInput: true })).toBe(0);
    expect(getAgentStatusPriority({ status: "running", awaitingInput: true })).toBe(2);
    expect(getAgentStatusPriority({ status: "error", awaitingInput: true })).toBe(1);
  });
});
