import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type pino from "pino";
import {
  AttentionFocus,
  buildFocusSummary,
  MAX_ATTENTION_FOCUS_MS,
  type HeldAttentionEntry,
} from "./attention-focus.js";

const MINUTE = 60_000;

function entry(agentId: string, title: string | null = agentId): HeldAttentionEntry {
  return {
    agentId,
    title,
    reason: "permission",
    awaitingInput: false,
    at: new Date().toISOString(),
  };
}

describe("AttentionFocus", () => {
  let dir: string;
  let filePath: string;
  const onChange = vi.fn();
  const onEnded = vi.fn();
  const logger = { warn: vi.fn() } as unknown as pino.Logger;

  function create() {
    return new AttentionFocus({ filePath, logger, onChange, onEnded });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T12:00:00.000Z"));
    dir = mkdtempSync(join(tmpdir(), "paseo-focus-"));
    filePath = join(dir, "focus.json");
    onChange.mockClear();
    onEnded.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("counts an agent and a terminal with the same id separately", () => {
    const focus = create();
    focus.start();
    focus.set(25 * MINUTE);
    focus.hold(entry("x"));
    focus.hold({ ...entry("x"), agentId: undefined, terminalId: "x" });
    expect(focus.getState().heldCount).toBe(2);
  });

  it("starts inactive", () => {
    const focus = create();
    focus.start();
    expect(focus.getState()).toEqual({
      active: false,
      until: null,
      startedAt: null,
      source: null,
      heldCount: 0,
    });
  });

  it("starts, replaces, and ends a period", () => {
    const focus = create();
    focus.start();

    expect(focus.set(25 * MINUTE)).toEqual({
      active: true,
      until: "2026-10-27T12:25:00.000Z",
      startedAt: "2026-10-27T12:00:00.000Z",
      source: "manual",
      heldCount: 0,
    });

    focus.hold(entry("a"));
    vi.advanceTimersByTime(5 * MINUTE);
    expect(focus.set(60 * MINUTE)).toMatchObject({
      startedAt: "2026-10-27T12:05:00.000Z",
      until: "2026-10-27T13:05:00.000Z",
      heldCount: 1,
    });

    expect(focus.set(null).active).toBe(false);
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it("rejects durations that are not positive or exceed 8 hours", () => {
    const focus = create();
    focus.start();
    expect(() => focus.set(0)).toThrow();
    expect(() => focus.set(-1)).toThrow();
    expect(() => focus.set(Number.NaN)).toThrow();
    expect(() => focus.set(MAX_ATTENTION_FOCUS_MS + 1)).toThrow();
    expect(focus.set(MAX_ATTENTION_FOCUS_MS).active).toBe(true);
  });

  it("dedupes held entries by agent, keeping the latest", () => {
    const focus = create();
    focus.start();
    focus.set(25 * MINUTE);
    focus.hold(entry("a", "old"));
    focus.hold(entry("b"));
    focus.hold(entry("a", "new"));
    expect(focus.getState().heldCount).toBe(2);
    focus.set(null);
    expect(onEnded.mock.calls[0][0].map((held: HeldAttentionEntry) => held.title)).toEqual([
      "b",
      "new",
    ]);
  });

  it("ends by timer and releases held entries once", () => {
    const focus = create();
    focus.start();
    focus.set(25 * MINUTE);
    focus.hold(entry("a"));

    vi.advanceTimersByTime(25 * MINUTE);

    expect(focus.getState().active).toBe(false);
    expect(onEnded).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60 * MINUTE);
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it("does not call onEnded when nothing was held", () => {
    const focus = create();
    focus.start();
    focus.set(MINUTE);
    vi.advanceTimersByTime(MINUTE);
    expect(onEnded).not.toHaveBeenCalled();
  });

  it("restores an active period and its held list after a restart", () => {
    const first = create();
    first.start();
    first.set(25 * MINUTE);
    first.hold(entry("a"));
    first.dispose();

    vi.advanceTimersByTime(10 * MINUTE);
    const second = create();
    second.start();

    expect(second.getState()).toMatchObject({
      startedAt: "2026-10-27T12:00:00.000Z",
      active: true,
      until: "2026-10-27T12:25:00.000Z",
      heldCount: 1,
    });
    vi.advanceTimersByTime(15 * MINUTE);
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(onEnded.mock.calls[0][0]).toHaveLength(1);
  });

  it("treats a period that expired while the daemon was down as ended and delivers its summary", () => {
    const first = create();
    first.start();
    first.set(25 * MINUTE);
    first.hold(entry("a"));
    first.dispose();

    vi.advanceTimersByTime(40 * MINUTE);
    const second = create();
    second.start();

    expect(second.getState().active).toBe(false);
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toMatchObject({ until: null, held: [] });

    const third = create();
    third.start();
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it("treats a persisted period without startedAt as unknown", () => {
    writeFileSync(
      filePath,
      JSON.stringify({ until: "2026-10-27T12:25:00.000Z", source: "manual", held: [] }),
    );
    const focus = create();
    focus.start();
    expect(focus.getState()).toMatchObject({ active: true, startedAt: null });
  });

  it("ignores a corrupt file", () => {
    writeFileSync(filePath, "not json");
    const focus = create();
    focus.start();
    expect(focus.getState().active).toBe(false);
  });
});

describe("buildFocusSummary", () => {
  it("names terminals as sessions", () => {
    const terminal: HeldAttentionEntry = {
      terminalId: "term-1",
      title: "bash",
      reason: "permission",
      awaitingInput: true,
      at: new Date().toISOString(),
    };
    expect(buildFocusSummary([terminal])).toEqual({
      title: "Focus ended: 1 session needs you",
      body: "bash",
    });
    expect(buildFocusSummary([terminal, entry("a", "Alpha")]).title).toBe(
      "Focus ended: 2 sessions need you",
    );
  });

  it("names the held agents", () => {
    expect(buildFocusSummary([entry("a", "Alpha")])).toEqual({
      title: "Focus ended: 1 agent needs you",
      body: "Alpha",
    });
    expect(buildFocusSummary([entry("a", "Alpha"), entry("b", "Beta")])).toEqual({
      title: "Focus ended: 2 agents need you",
      body: "Alpha, Beta",
    });
  });

  it("caps the list at five and counts the rest", () => {
    const held = ["a", "b", "c", "d", "e", "f", "g"].map((id) => entry(id));
    expect(buildFocusSummary(held).body).toBe("a, b, c, d, e and 2 more");
  });

  it("falls back for untitled agents", () => {
    expect(buildFocusSummary([entry("a", null)]).body).toBe("Untitled agent");
  });
});

describe("AttentionFocus calendar", () => {
  let dir: string;
  let filePath: string;
  const onChange = vi.fn();
  const logger = { warn: vi.fn() } as unknown as pino.Logger;
  const block = (minutes: number, eventKey = "uid|start") => ({
    startedAt: new Date(Date.now() - 5 * MINUTE),
    until: new Date(Date.now() + minutes * MINUTE),
    eventKey,
  });

  function create() {
    const focus = new AttentionFocus({ filePath, logger, onChange, onEnded: vi.fn() });
    focus.start();
    return focus;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T12:00:00.000Z"));
    dir = mkdtempSync(join(tmpdir(), "paseo-focus-cal-"));
    filePath = join(dir, "focus.json");
    onChange.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts a calendar period from the block", () => {
    const focus = create();
    focus.applyCalendar(block(30));
    expect(focus.getState()).toMatchObject({
      active: true,
      source: "calendar",
      startedAt: "2026-10-27T11:55:00.000Z",
      until: "2026-10-27T12:30:00.000Z",
    });
    vi.advanceTimersByTime(31 * MINUTE);
    expect(focus.getState().active).toBe(false);
    focus.dispose();
  });

  it("extends a shorter manual period and leaves a longer one alone", () => {
    const focus = create();
    focus.set(10 * MINUTE);
    focus.applyCalendar(block(30));
    expect(focus.getState()).toMatchObject({ source: "calendar" });
    expect(focus.getState().until).toBe("2026-10-27T12:30:00.000Z");

    focus.set(60 * MINUTE);
    focus.applyCalendar(block(30));
    expect(focus.getState()).toMatchObject({
      source: "manual",
      until: "2026-10-27T13:00:00.000Z",
    });
    focus.dispose();
  });

  it("follows a change to the end of a calendar-owned block", () => {
    const focus = create();
    focus.applyCalendar(block(30));
    focus.applyCalendar(block(45));
    expect(focus.getState().until).toBe("2026-10-27T12:45:00.000Z");
    focus.dispose();
  });

  it("does not restart a block the user ended, and remembers it across restarts", () => {
    const focus = create();
    focus.applyCalendar(block(30, "uid|first"));
    focus.set(null);
    focus.applyCalendar(block(30, "uid|first"));
    expect(focus.getState().active).toBe(false);
    focus.dispose();

    expect(JSON.parse(readFileSync(filePath, "utf8")).dismissedCalendarKeys).toEqual(["uid|first"]);
    const restarted = create();
    restarted.applyCalendar(block(30, "uid|first"));
    expect(restarted.getState().active).toBe(false);
    restarted.applyCalendar(block(30, "uid|second"));
    expect(restarted.getState().active).toBe(true);
    restarted.dispose();
  });

  it("does not dismiss anything when the period ends by itself", () => {
    const focus = create();
    focus.applyCalendar(block(30));
    vi.advanceTimersByTime(31 * MINUTE);
    expect(JSON.parse(readFileSync(filePath, "utf8")).dismissedCalendarKeys).toEqual([]);
    focus.dispose();
  });

  it("keeps at most 50 dismissed keys", () => {
    const focus = create();
    for (let i = 0; i < 55; i += 1) {
      focus.applyCalendar(block(30, `uid|${i}`));
      focus.set(null);
    }
    const keys = JSON.parse(readFileSync(filePath, "utf8")).dismissedCalendarKeys as string[];
    expect(keys).toHaveLength(50);
    expect(keys[49]).toBe("uid|54");
    focus.dispose();
  });
});
