import { describe, expect, it } from "vitest";
import {
  FOCUS_DURATION_OPTIONS_MS,
  focusBarFraction,
  focusRemainingMs,
  formatFocusRemaining,
} from "./format";

const MINUTE = 60_000;

describe("formatFocusRemaining", () => {
  it("rounds minutes up", () => {
    expect(formatFocusRemaining(42 * MINUTE)).toEqual({ kind: "minutes", minutes: 42 });
    expect(formatFocusRemaining(41 * MINUTE + 1)).toEqual({ kind: "minutes", minutes: 42 });
    expect(formatFocusRemaining(MINUTE)).toEqual({ kind: "minutes", minutes: 1 });
  });

  it("reads under a minute as less than a minute", () => {
    expect(formatFocusRemaining(59_999)).toEqual({ kind: "lessThanMinute" });
    expect(formatFocusRemaining(0)).toEqual({ kind: "lessThanMinute" });
  });
});

describe("focusRemainingMs", () => {
  it("never goes negative and tolerates a bad timestamp", () => {
    const now = Date.parse("2026-10-27T12:00:00.000Z");
    expect(focusRemainingMs("2026-10-27T12:25:00.000Z", now)).toBe(25 * MINUTE);
    expect(focusRemainingMs("2026-10-27T11:00:00.000Z", now)).toBe(0);
    expect(focusRemainingMs("nonsense", now)).toBe(0);
  });
});

describe("focusBarFraction", () => {
  it("starts full for each menu option and is empty at the end", () => {
    for (const option of FOCUS_DURATION_OPTIONS_MS) {
      expect(focusBarFraction(option)).toBe(1);
      expect(focusBarFraction(0)).toBe(0);
    }
  });

  it("infers the period from the smallest option that covers what is left", () => {
    expect(focusBarFraction(20 * MINUTE)).toBeCloseTo(20 / 25, 5);
    expect(focusBarFraction(30 * MINUTE)).toBeCloseTo(30 / 60, 5);
    expect(focusBarFraction(90 * MINUTE)).toBeCloseTo(90 / 120, 5);
  });

  it("treats a few seconds of skew over an option as a full bar", () => {
    expect(focusBarFraction(25 * MINUTE + 3_000)).toBe(1);
  });

  it("shows a full bar for a period longer than any option", () => {
    expect(focusBarFraction(3 * 60 * MINUTE)).toBe(1);
  });
});
