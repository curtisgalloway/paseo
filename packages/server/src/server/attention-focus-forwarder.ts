import type pino from "pino";
import type { AttentionFocusState } from "@getpaseo/protocol/messages";
import type { AcceptedHost } from "./connected-hosts/index.js";
import { MAX_ATTENTION_FOCUS_MS } from "./attention-focus.js";

interface HostSource {
  acceptedHosts(): AcceptedHost[];
  onHostAccepted(listener: (host: AcceptedHost) => void): () => void;
}

interface AttentionFocusForwarderOptions {
  hosts: HostSource;
  getState: () => AttentionFocusState;
  logger: pino.Logger;
  now?: () => number;
}

/**
 * Relays this daemon's focus period to its connected hosts so a hub's focus holds Caution
 * notifications there too. Only changes that start here are relayed: callers pass
 * `forwarded: true` for a change that arrived from another daemon, which is recorded but not
 * sent on, so focus cannot loop between daemons. Delivery is fire-and-forget.
 */
export class AttentionFocusForwarder {
  // Identity of the period last seen (its end time, or null when none), so held-count changes
  // inside one period are not relayed.
  private lastKey: string | null = null;
  private readonly unsubscribe: () => void;
  private readonly now: () => number;

  constructor(private readonly options: AttentionFocusForwarderOptions) {
    this.now = options.now ?? Date.now;
    this.unsubscribe = options.hosts.onHostAccepted((host) => {
      const state = this.options.getState();
      if (!state.active) return;
      this.send([host], this.durationOf(state));
    });
  }

  dispose(): void {
    this.unsubscribe();
  }

  // Call on every focus state change.
  onFocusChange(state: AttentionFocusState, origin: { forwarded: boolean }): void {
    const key = state.active ? state.until : null;
    if (key === this.lastKey) return;
    this.lastKey = key;
    if (origin.forwarded) return;
    this.send(this.options.hosts.acceptedHosts(), state.active ? this.durationOf(state) : null);
  }

  private durationOf(state: AttentionFocusState): number | null {
    const until = state.until ? Date.parse(state.until) : Number.NaN;
    if (!Number.isFinite(until)) return null;
    return Math.min(until - this.now(), MAX_ATTENTION_FOCUS_MS);
  }

  private send(hosts: AcceptedHost[], durationMs: number | null): void {
    if (durationMs !== null && durationMs <= 0) return;
    for (const host of hosts) {
      if (host.client.getLastServerInfoMessage()?.features?.attentionFocus !== true) continue;
      void host.client
        .setAttentionFocus(durationMs, undefined, { forwarded: true })
        .catch((err) => {
          this.options.logger.warn(
            { err, serverId: host.serverId },
            "Failed to forward focus to connected host",
          );
        });
    }
  }
}
