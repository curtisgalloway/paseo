const MINUTE_MS = 60_000;

/** The durations the Focus menu offers, in the order it lists them. */
export const FOCUS_DURATION_OPTIONS_MS = [25 * MINUTE_MS, 60 * MINUTE_MS, 120 * MINUTE_MS] as const;

// The daemon stores only when focus ends, so the bar infers the length of the period as the
// smallest menu option that still covers what is left. Clock skew can make a fresh period read a
// few seconds over its option.
const FULL_BAR_TOLERANCE_MS = 5_000;

export type FocusRemaining = { kind: "lessThanMinute" } | { kind: "minutes"; minutes: number };

export function focusRemainingMs(untilIso: string, nowMs: number): number {
  const untilMs = Date.parse(untilIso);
  if (!Number.isFinite(untilMs)) return 0;
  return Math.max(0, untilMs - nowMs);
}

/** Whole minutes, rounded up, so the label never reads "0 min left" while time remains. */
export function formatFocusRemaining(remainingMs: number): FocusRemaining {
  if (remainingMs < MINUTE_MS) return { kind: "lessThanMinute" };
  return { kind: "minutes", minutes: Math.ceil(remainingMs / MINUTE_MS) };
}

/**
 * 1 when the period has just started, shrinking to 0 as it ends. With `startedAt` the length is
 * exact; without it (an older daemon) the length is inferred from the menu options.
 */
export function focusBarFraction(
  remainingMs: number,
  period?: { startedAt?: string | null; until: string | null },
): number {
  if (remainingMs <= 0) return 0;
  const startedMs = period?.startedAt ? Date.parse(period.startedAt) : Number.NaN;
  const untilMs = period?.until ? Date.parse(period.until) : Number.NaN;
  if (Number.isFinite(startedMs) && Number.isFinite(untilMs) && untilMs > startedMs) {
    return Math.min(1, remainingMs / (untilMs - startedMs));
  }
  const total =
    FOCUS_DURATION_OPTIONS_MS.find((option) => remainingMs <= option + FULL_BAR_TOLERANCE_MS) ??
    remainingMs;
  return Math.min(1, remainingMs / total);
}
