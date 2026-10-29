import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AttentionLog,
  attentionDelivery,
  type AttentionDelivery,
  type AttentionLogEvent,
} from "./attention-log.js";

const HOUR = 60 * 60 * 1000;

function event(overrides: Partial<AttentionLogEvent> = {}): AttentionLogEvent {
  return {
    agentId: "agent-1",
    workspaceId: "ws-1",
    provider: "claude",
    reason: "error",
    awaitingInput: false,
    tier: "caution",
    delivery: "in_app",
    ...overrides,
  };
}

describe("AttentionLog", () => {
  let dir: string;
  let file: string;
  let nowMs: number;
  let warn: ReturnType<typeof vi.fn>;

  function create(maxBytes?: number, filePath = file) {
    return new AttentionLog({
      filePath,
      logger: { warn } as unknown as pino.Logger,
      now: () => nowMs,
      maxBytes,
    });
  }
  const lines = (path = file) =>
    readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "attention-log-test-"));
    file = join(dir, "attention-log.jsonl");
    nowMs = Date.parse("2026-10-28T12:00:00.000Z");
    warn = vi.fn();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("logs a terminal event with terminalId and no agentId", () => {
    const log = create();
    const { agentId: _agentId, ...terminal } = event({
      reason: "permission",
      provider: "terminal",
    });
    log.recordAttention({ ...terminal, terminalId: "term-1" });
    log.recordActed("term-1");

    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({
      kind: "attention",
      terminalId: "term-1",
      reason: "permission",
      provider: "terminal",
    });
    expect(lines()[0]).not.toHaveProperty("agentId");
  });

  it("writes an event line for each delivery value, mode 600", () => {
    const log = create();
    const deliveries: AttentionDelivery[] = [
      "in_app",
      "push",
      "held",
      "none",
      "suppressed_focused",
    ];
    for (const delivery of deliveries) log.recordAttention(event({ delivery }));
    const written = lines();
    expect(written.map((line) => line.delivery)).toEqual(deliveries);
    expect(written[0]).toEqual({
      schemaVersion: 1,
      kind: "attention",
      at: "2026-10-28T12:00:00.000Z",
      ...event({ delivery: "in_app" }),
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("writes a focus summary line with heldCount", () => {
    create().recordFocusSummary({ ...event({ delivery: "push" }), heldCount: 3 });
    expect(lines()[0]).toMatchObject({ kind: "focus_summary", heldCount: 3, delivery: "push" });
  });

  it("writes an acted line with latency, once per event", () => {
    const log = create();
    log.recordAttention(event());
    nowMs += 90_000;
    log.recordActed("agent-1");
    log.recordActed("agent-1");
    const written = lines();
    expect(written).toHaveLength(2);
    expect(written[1]).toEqual({
      schemaVersion: 1,
      kind: "acted",
      at: "2026-10-28T12:01:30.000Z",
      agentId: "agent-1",
      latencyMs: 90_000,
    });
  });

  it("writes no acted line when no event is unmatched", () => {
    const log = create();
    log.recordActed("agent-1");
    log.recordAttention(event({ agentId: "agent-2" }));
    log.recordActed("agent-1");
    expect(lines()).toHaveLength(1);
  });

  it("ignores an unmatched event older than 24 hours", () => {
    const log = create();
    log.recordAttention(event());
    nowMs += 24 * HOUR + 1;
    log.recordActed("agent-1");
    expect(lines()).toHaveLength(1);
  });

  it("rotates to attention-log.1.jsonl at the size limit, replacing the old one", () => {
    const rotated = join(dir, "attention-log.1.jsonl");
    writeFileSync(rotated, "old\n");
    const log = create(200);
    for (let i = 0; i < 4; i += 1) log.recordAttention(event({ agentId: `a${i}` }));
    expect(existsSync(rotated)).toBe(true);
    expect(readFileSync(rotated, "utf8")).not.toContain("old");
    const current = lines();
    expect(current.length).toBeGreaterThan(0);
  });

  it("does not throw on write failure and warns once per kind", () => {
    const readonly = join(dir, "ro");
    writeFileSync(readonly, "not a directory");
    const log = create(undefined, join(readonly, "attention-log.jsonl"));
    expect(() => {
      log.recordAttention(event());
      log.recordAttention(event());
      log.recordActed("agent-1");
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not throw when the log file cannot be appended", () => {
    writeFileSync(file, "");
    chmodSync(file, 0o400);
    const log = create();
    expect(() => log.recordAttention(event())).not.toThrow();
    chmodSync(file, 0o600);
  });
});

describe("attentionDelivery", () => {
  const idle = { inAppRecipientIndex: null, shouldPush: false };
  it("maps routing outcomes", () => {
    const base = { tier: "caution", held: false, plan: idle, recipientCount: 1 } as const;
    expect(attentionDelivery({ ...base, held: true })).toBe("held");
    expect(attentionDelivery({ ...base, tier: "advisory" })).toBe("none");
    expect(attentionDelivery({ ...base, plan: { ...idle, inAppRecipientIndex: 0 } })).toBe(
      "in_app",
    );
    expect(attentionDelivery({ ...base, plan: { ...idle, shouldPush: true } })).toBe("push");
    expect(attentionDelivery(base)).toBe("suppressed_focused");
    expect(attentionDelivery({ ...base, recipientCount: 0 })).toBe("none");
  });
});
