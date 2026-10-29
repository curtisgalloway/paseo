import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type pino from "pino";
import type { AgentAttentionReason } from "@getpaseo/protocol/agent-attention-notification";
import type { AttentionTier, NotificationPlan } from "./agent-attention-policy.js";

export const ATTENTION_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const ATTENTION_LOG_UNMATCHED_TTL_MS = 24 * 60 * 60 * 1000;

export type AttentionDelivery = "in_app" | "push" | "held" | "none" | "suppressed_focused";

// Maps the routing outcome to a log value. A non-advisory event with neither an in-app
// recipient nor a push, while clients were present, means they were already looking at it.
export function attentionDelivery(input: {
  tier: AttentionTier;
  held: boolean;
  plan: NotificationPlan;
  recipientCount: number;
}): AttentionDelivery {
  if (input.held) return "held";
  if (input.tier === "advisory") return "none";
  if (input.plan.inAppRecipientIndex !== null) return "in_app";
  if (input.plan.shouldPush) return "push";
  return input.recipientCount > 0 ? "suppressed_focused" : "none";
}

export interface AttentionLogEvent {
  // Exactly one of agentId / terminalId.
  agentId?: string;
  terminalId?: string;
  workspaceId: string;
  provider: string;
  reason: AgentAttentionReason;
  awaitingInput: boolean;
  tier: AttentionTier;
  delivery: AttentionDelivery;
}

interface AttentionLogOptions {
  // Full path of attention-log.jsonl; the rotated file sits next to it.
  filePath: string;
  logger: pino.Logger;
  now?: () => number;
  maxBytes?: number;
}

/**
 * Append-only interruption log for reviewing the attention budget. Lines hold ids and enums
 * only (no titles, message text, or paths). Writes never throw into the attention path.
 */
export class AttentionLog {
  // agentId -> time of its latest attention event that no "acted" line has matched yet.
  private readonly unmatched = new Map<string, number>();
  private readonly warned = new Set<string>();
  private readonly now: () => number;
  private readonly maxBytes: number;

  constructor(private readonly options: AttentionLogOptions) {
    this.now = options.now ?? Date.now;
    this.maxBytes = options.maxBytes ?? ATTENTION_LOG_MAX_BYTES;
  }

  recordAttention(event: AttentionLogEvent): void {
    const at = this.now();
    this.append({ schemaVersion: 1, kind: "attention", at: new Date(at).toISOString(), ...event });
    // Terminal attention has no "acted" matching yet, so it is not tracked.
    if (event.agentId !== undefined) this.unmatched.set(event.agentId, at);
  }

  recordFocusSummary(event: AttentionLogEvent & { heldCount: number }): void {
    this.append({
      schemaVersion: 1,
      kind: "focus_summary",
      at: new Date(this.now()).toISOString(),
      ...event,
    });
  }

  // The user cleared the agent's attention or replied to it. No line without a matching event.
  recordActed(agentId: string): void {
    const eventAt = this.unmatched.get(agentId);
    if (eventAt === undefined) {
      return;
    }
    this.unmatched.delete(agentId);
    const nowMs = this.now();
    const latencyMs = nowMs - eventAt;
    if (latencyMs > ATTENTION_LOG_UNMATCHED_TTL_MS) {
      return;
    }
    this.append({
      schemaVersion: 1,
      kind: "acted",
      at: new Date(nowMs).toISOString(),
      agentId,
      latencyMs: Math.max(0, latencyMs),
    });
    this.pruneExpired(nowMs);
  }

  private pruneExpired(nowMs: number): void {
    for (const [agentId, eventAt] of this.unmatched) {
      if (nowMs - eventAt > ATTENTION_LOG_UNMATCHED_TTL_MS) {
        this.unmatched.delete(agentId);
      }
    }
  }

  private append(line: Record<string, unknown>): void {
    const { filePath } = this.options;
    try {
      mkdirSync(dirname(filePath), { recursive: true });
    } catch (err) {
      this.warnOnce("mkdir", err);
      return;
    }
    try {
      const size = statSync(filePath, { throwIfNoEntry: false })?.size ?? 0;
      if (size >= this.maxBytes) {
        this.rotate();
      }
    } catch (err) {
      this.warnOnce("rotate", err);
    }
    try {
      appendFileSync(filePath, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    } catch (err) {
      this.warnOnce("append", err);
    }
  }

  private rotate(): void {
    const { filePath } = this.options;
    const name = basename(filePath, ".jsonl");
    renameSync(filePath, join(dirname(filePath), `${name}.1.jsonl`));
  }

  private warnOnce(kind: string, err: unknown): void {
    if (this.warned.has(kind)) {
      return;
    }
    this.warned.add(kind);
    this.options.logger.warn({ err, kind }, "Attention log write failed");
  }
}
