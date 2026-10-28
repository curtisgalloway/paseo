import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type pino from "pino";
import type { AgentAttentionReason } from "@getpaseo/protocol/agent-attention-notification";
import type { AttentionFocusState } from "@getpaseo/protocol/messages";

export const MAX_ATTENTION_FOCUS_MS = 8 * 60 * 60 * 1000;
const SUMMARY_TITLE_LIMIT = 5;

export interface HeldAttentionEntry {
  agentId: string;
  title: string | null;
  reason: AgentAttentionReason;
  awaitingInput: boolean;
  at: string;
}

interface PersistedFocus {
  until: string | null;
  startedAt?: string | null;
  source: string | null;
  held: HeldAttentionEntry[];
}

interface AttentionFocusOptions {
  filePath: string;
  logger: pino.Logger;
  // Called whenever the public state changes (start, replace, end, a held event).
  onChange: (state: AttentionFocusState) => void;
  // Called once when focus ends with at least one held entry.
  onEnded: (held: HeldAttentionEntry[]) => void;
  now?: () => number;
}

/**
 * Daemon-wide focus period. While active, Caution-tier attention is held instead of notified;
 * ending it (timer, explicit, or an expired file found at startup) releases one summary.
 */
export class AttentionFocus {
  private until: number | null = null;
  private startedAt: number | null = null;
  private source: string | null = null;
  private held: HeldAttentionEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: AttentionFocusOptions) {
    this.now = options.now ?? Date.now;
  }

  // Loads the persisted state; an expired period ends immediately and releases its summary.
  start(): void {
    const persisted = this.read();
    if (persisted?.until) {
      const until = Date.parse(persisted.until);
      if (Number.isFinite(until)) {
        this.until = until;
        const started = persisted.startedAt ? Date.parse(persisted.startedAt) : Number.NaN;
        this.startedAt = Number.isFinite(started) ? started : null;
        this.source = persisted.source;
        this.held = persisted.held;
      }
    }
    if (this.until === null) {
      return;
    }
    if (this.until <= this.now()) {
      this.end();
      return;
    }
    this.arm();
  }

  dispose(): void {
    this.clearTimer();
  }

  getState(): AttentionFocusState {
    const active = this.isActive();
    return {
      active,
      until: active && this.until !== null ? new Date(this.until).toISOString() : null,
      startedAt: active && this.startedAt !== null ? new Date(this.startedAt).toISOString() : null,
      source: active ? this.source : null,
      heldCount: active ? this.held.length : 0,
    };
  }

  isActive(): boolean {
    return this.until !== null && this.until > this.now();
  }

  // A positive duration starts or replaces the period; null ends it now.
  set(durationMs: number | null): AttentionFocusState {
    if (durationMs === null) {
      this.end();
      return this.getState();
    }
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_ATTENTION_FOCUS_MS) {
      throw new Error("Focus duration must be greater than 0 and at most 8 hours.");
    }
    if (!this.isActive()) {
      this.held = [];
    }
    this.startedAt = this.now();
    this.until = this.now() + durationMs;
    this.source = "manual";
    this.persist();
    this.arm();
    this.options.onChange(this.getState());
    return this.getState();
  }

  // Records a held Caution event. Latest entry per agent wins.
  hold(entry: HeldAttentionEntry): void {
    this.held = [...this.held.filter((held) => held.agentId !== entry.agentId), entry];
    this.persist();
    this.options.onChange(this.getState());
  }

  private end(): void {
    const held = this.held;
    this.clearTimer();
    this.until = null;
    this.startedAt = null;
    this.source = null;
    this.held = [];
    this.persist();
    this.options.onChange(this.getState());
    if (held.length > 0) {
      this.options.onEnded(held);
    }
  }

  private arm(): void {
    this.clearTimer();
    if (this.until === null) {
      return;
    }
    const delay = Math.max(0, this.until - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.end();
    }, delay);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private read(): PersistedFocus | null {
    try {
      const raw = JSON.parse(
        readFileSync(this.options.filePath, "utf8"),
      ) as Partial<PersistedFocus>;
      return {
        until: typeof raw.until === "string" ? raw.until : null,
        startedAt: typeof raw.startedAt === "string" ? raw.startedAt : null,
        source: typeof raw.source === "string" ? raw.source : null,
        held: Array.isArray(raw.held) ? raw.held : [],
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.options.logger.warn({ err }, "Failed to read focus state; starting without focus");
      }
      return null;
    }
  }

  private persist(): void {
    const data: PersistedFocus = {
      until: this.until === null ? null : new Date(this.until).toISOString(),
      startedAt: this.startedAt === null ? null : new Date(this.startedAt).toISOString(),
      source: this.source,
      held: this.held,
    };
    try {
      mkdirSync(dirname(this.options.filePath), { recursive: true });
      const tempPath = `${this.options.filePath}.tmp`;
      writeFileSync(tempPath, JSON.stringify(data));
      renameSync(tempPath, this.options.filePath);
    } catch (err) {
      this.options.logger.warn({ err }, "Failed to persist focus state");
    }
  }
}

export function buildFocusSummary(held: readonly HeldAttentionEntry[]): {
  title: string;
  body: string;
} {
  const count = held.length;
  const names = held.map((entry) => entry.title?.trim() || "Untitled agent");
  const shown = names.slice(0, SUMMARY_TITLE_LIMIT);
  const extra = names.length - shown.length;
  const body = extra > 0 ? `${shown.join(", ")} and ${extra} more` : shown.join(", ");
  return {
    title: `Focus ended: ${count} ${count === 1 ? "agent needs" : "agents need"} you`,
    body,
  };
}
