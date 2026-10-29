import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type pino from "pino";
import { AttentionCalendar } from "./attention-calendar.js";
import { AttentionFocus } from "./attention-focus.js";

const URL_A =
  "https://calendar.example.com/calendar/ical/me%40example.com/private-abc123/basic.ics";
const MINUTE = 60_000;

const VTIMEZONE_LA = `BEGIN:VTIMEZONE
TZID:America/Los_Angeles
BEGIN:DAYLIGHT
TZOFFSETFROM:-0800
TZOFFSETTO:-0700
TZNAME:PDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0700
TZOFFSETTO:-0800
TZNAME:PST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE`;

interface EventSpec {
  uid?: string;
  start?: string;
  end?: string;
  // Replaces the whole DTSTART/DTEND pair when set.
  times?: string;
  summary?: string;
  attendees?: string[];
  transp?: string;
  status?: string;
  extra?: string[];
}

let uidCounter = 0;

function vevent(spec: EventSpec): string {
  uidCounter += 1;
  const lines = ["BEGIN:VEVENT", `UID:${spec.uid ?? `event-${uidCounter}@example.com`}`];
  lines.push(spec.times ?? `DTSTART:${spec.start}\nDTEND:${spec.end}`);
  lines.push(`SUMMARY:${spec.summary ?? "Sync"}`);
  for (const attendee of spec.attendees ?? []) lines.push(attendee);
  if (spec.transp) lines.push(`TRANSP:${spec.transp}`);
  if (spec.status) lines.push(`STATUS:${spec.status}`);
  lines.push(...(spec.extra ?? []), "END:VEVENT");
  return lines.join("\n");
}

function ics(...events: string[]): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//example//test//EN",
    VTIMEZONE_LA,
    ...events,
    "END:VCALENDAR",
  ].join("\n");
}

const other = "ATTENDEE;PARTSTAT=ACCEPTED:mailto:colleague@example.com";
const self = (partstat: string) => `ATTENDEE;PARTSTAT=${partstat}:mailto:Me@Example.com`;

describe("AttentionCalendar", () => {
  let dir: string;
  let configPath: string;
  let now: number;
  const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as pino.Logger;
  const applyCalendar = vi.fn();

  function setNow(iso: string): void {
    now = Date.parse(iso);
    vi.setSystemTime(now);
  }

  function writeConfig(urls: string[]): void {
    writeFileSync(configPath, JSON.stringify({ icalUrls: urls }));
  }

  function calendarFor(body: string | (() => Promise<string>), focus = { applyCalendar }) {
    const fetchFn = vi.fn(async () => {
      const text = typeof body === "string" ? body : await body();
      return { ok: true, status: 200, text: async () => text };
    });
    const calendar = new AttentionCalendar({
      configPath,
      logger,
      focus,
      fetchFn,
      now: () => now,
    });
    return { calendar, fetchFn };
  }

  async function applied(body: string, nowIso = "2026-10-27T12:00:00Z") {
    setNow(nowIso);
    writeConfig([URL_A]);
    const { calendar } = calendarFor(body);
    await calendar.poll();
    calendar.dispose();
    return applyCalendar.mock.calls.map(([block]) => ({
      until: block.until.toISOString(),
      startedAt: block.startedAt.toISOString(),
      eventKey: block.eventKey,
    }));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), "paseo-calendar-"));
    configPath = join(dir, "attention-calendar.json");
    applyCalendar.mockClear();
    vi.mocked(logger.warn).mockClear();
    setNow("2026-10-27T12:00:00Z");
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("which occurrences qualify", () => {
    it("a meeting with another attendee qualifies", async () => {
      const calls = await applied(
        ics(
          vevent({
            uid: "m1@example.com",
            start: "20261027T113000Z",
            end: "20261027T123000Z",
            attendees: [self("ACCEPTED"), other],
          }),
        ),
      );
      expect(calls).toEqual([
        {
          startedAt: "2026-10-27T11:30:00.000Z",
          until: "2026-10-27T12:30:00.000Z",
          eventKey: "m1@example.com|2026-10-27T11:30:00.000Z",
        },
      ]);
    });

    it("a solo busy block does not qualify", async () => {
      const calls = await applied(
        ics(
          vevent({
            start: "20261027T113000Z",
            end: "20261027T123000Z",
            attendees: [self("ACCEPTED")],
          }),
          vevent({ start: "20261027T113000Z", end: "20261027T123000Z" }),
        ),
      );
      expect(calls).toEqual([]);
    });

    it("a solo block titled Focus qualifies", async () => {
      const calls = await applied(
        ics(vevent({ start: "20261027T113000Z", end: "20261027T123000Z", summary: " focus " })),
      );
      expect(calls).toHaveLength(1);
    });

    it("[focus] anywhere in the title qualifies", async () => {
      const calls = await applied(
        ics(
          vevent({
            start: "20261027T113000Z",
            end: "20261027T123000Z",
            summary: "Write report [Focus]",
          }),
        ),
      );
      expect(calls).toHaveLength(1);
    });

    it("a title that merely contains the word focus does not qualify", async () => {
      const calls = await applied(
        ics(vevent({ start: "20261027T113000Z", end: "20261027T123000Z", summary: "Focus group" })),
      );
      expect(calls).toEqual([]);
    });

    it("a transparent meeting does not qualify", async () => {
      const calls = await applied(
        ics(
          vevent({
            start: "20261027T113000Z",
            end: "20261027T123000Z",
            attendees: [other],
            transp: "TRANSPARENT",
          }),
        ),
      );
      expect(calls).toEqual([]);
    });

    it("an all-day event does not qualify", async () => {
      const calls = await applied(
        ics(
          vevent({
            times: "DTSTART;VALUE=DATE:20261027\nDTEND;VALUE=DATE:20261028",
            attendees: [other],
            summary: "Focus",
          }),
        ),
      );
      expect(calls).toEqual([]);
    });

    it("a cancelled event does not qualify", async () => {
      const calls = await applied(
        ics(
          vevent({
            start: "20261027T113000Z",
            end: "20261027T123000Z",
            attendees: [other],
            status: "CANCELLED",
          }),
        ),
      );
      expect(calls).toEqual([]);
    });

    it("a meeting the owner declined does not qualify", async () => {
      const calls = await applied(
        ics(
          vevent({
            start: "20261027T113000Z",
            end: "20261027T123000Z",
            attendees: [self("DECLINED"), other],
          }),
        ),
      );
      expect(calls).toEqual([]);
    });

    it("converts a TZID event to the right instant", async () => {
      const calls = await applied(
        ics(
          vevent({
            uid: "tz@example.com",
            times:
              "DTSTART;TZID=America/Los_Angeles:20261027T100000\n" +
              "DTEND;TZID=America/Los_Angeles:20261027T110000",
            attendees: [other],
          }),
        ),
        "2026-10-27T17:15:00Z",
      );
      expect(calls).toEqual([
        {
          startedAt: "2026-10-27T17:00:00.000Z",
          until: "2026-10-27T18:00:00.000Z",
          eventKey: "tz@example.com|2026-10-27T17:00:00.000Z",
        },
      ]);
    });
  });

  describe("recurring events", () => {
    const series = ics(
      vevent({
        uid: "weekly@example.com",
        start: "20261013T100000Z",
        end: "20261013T110000Z",
        attendees: [other],
        extra: ["RRULE:FREQ=WEEKLY", "EXDATE:20261103T100000Z"],
      }),
      vevent({
        uid: "weekly@example.com",
        start: "20261110T150000Z",
        end: "20261110T160000Z",
        attendees: [other],
        extra: ["RECURRENCE-ID:20261110T100000Z"],
      }),
    );

    async function keysAt(nowIso: string): Promise<string[]> {
      applyCalendar.mockClear();
      setNow(nowIso);
      const { calendar } = calendarFor(series);
      writeConfig([URL_A]);
      await calendar.poll();
      calendar.dispose();
      return applyCalendar.mock.calls.map(([block]) => block.eventKey);
    }

    it("expands a normal occurrence", async () => {
      expect(await keysAt("2026-10-27T10:30:00Z")).toEqual([
        "weekly@example.com|2026-10-27T10:00:00.000Z",
      ]);
    });

    it("skips an EXDATE occurrence", async () => {
      expect(await keysAt("2026-11-03T10:30:00Z")).toEqual([]);
    });

    it("replaces a moved occurrence at its new time", async () => {
      expect(await keysAt("2026-11-10T10:30:00Z")).toEqual([]);
      expect(await keysAt("2026-11-10T15:30:00Z")).toEqual([
        "weekly@example.com|2026-11-10T15:00:00.000Z",
      ]);
    });

    it("resumes the normal pattern after the override", async () => {
      expect(await keysAt("2026-11-17T10:30:00Z")).toEqual([
        "weekly@example.com|2026-11-17T10:00:00.000Z",
      ]);
    });
  });

  it("chains back-to-back meetings into one block", async () => {
    const calls = await applied(
      ics(
        vevent({
          uid: "a@example.com",
          start: "20261027T110000Z",
          end: "20261027T113000Z",
          attendees: [other],
        }),
        vevent({
          uid: "b@example.com",
          start: "20261027T113000Z",
          end: "20261027T123000Z",
          attendees: [other],
        }),
        vevent({
          uid: "c@example.com",
          start: "20261027T123000Z",
          end: "20261027T130000Z",
          attendees: [other],
        }),
        vevent({
          uid: "d@example.com",
          start: "20261027T131500Z",
          end: "20261027T140000Z",
          attendees: [other],
        }),
      ),
      "2026-10-27T11:45:00Z",
    );
    expect(calls).toEqual([
      {
        startedAt: "2026-10-27T11:00:00.000Z",
        until: "2026-10-27T13:00:00.000Z",
        eventKey: "a@example.com|2026-10-27T11:00:00.000Z",
      },
    ]);
  });

  describe("driving a real focus period", () => {
    let focus: AttentionFocus;
    const body = ics(
      vevent({
        uid: "one@example.com",
        start: "20261027T113000Z",
        end: "20261027T123000Z",
        attendees: [other],
      }),
      vevent({
        uid: "two@example.com",
        start: "20261027T130000Z",
        end: "20261027T140000Z",
        attendees: [other],
      }),
    );

    beforeEach(() => {
      focus = new AttentionFocus({
        filePath: join(dir, "focus.json"),
        logger,
        onChange: vi.fn(),
        onEnded: vi.fn(),
        now: () => now,
      });
      focus.start();
    });

    afterEach(() => focus.dispose());

    it("does not restart a dismissed block, but starts the next one", async () => {
      writeConfig([URL_A]);
      const { calendar } = calendarFor(body, focus);
      await calendar.poll();
      expect(focus.getState()).toMatchObject({ active: true, source: "calendar" });

      focus.set(null);
      calendar.evaluate();
      expect(focus.getState().active).toBe(false);

      setNow("2026-10-27T13:30:00Z");
      calendar.evaluate();
      expect(focus.getState()).toMatchObject({
        active: true,
        source: "calendar",
        until: "2026-10-27T14:00:00.000Z",
      });
      calendar.dispose();
    });

    it("extends a shorter manual period but never shortens a longer one", async () => {
      writeConfig([URL_A]);
      const { calendar } = calendarFor(body, focus);
      focus.set(15 * MINUTE);
      await calendar.poll();
      expect(focus.getState()).toMatchObject({
        source: "calendar",
        until: "2026-10-27T12:30:00.000Z",
      });

      focus.set(120 * MINUTE);
      calendar.evaluate();
      expect(focus.getState()).toMatchObject({
        source: "manual",
        until: "2026-10-27T14:00:00.000Z",
      });
      calendar.dispose();
    });
  });

  describe("polling", () => {
    it("keeps the last good events when a refresh fails", async () => {
      writeConfig([URL_A]);
      let fail = false;
      const feed = async () => {
        if (fail) throw new Error(`boom ${URL_A}`);
        return good;
      };
      const good = ics(
        vevent({
          start: "20261027T113000Z",
          end: "20261027T123000Z",
          attendees: [other],
          summary: "Secret planning",
        }),
      );
      const { calendar } = calendarFor(feed);
      await calendar.poll();
      expect(applyCalendar).toHaveBeenCalledTimes(1);

      fail = true;
      await calendar.poll();
      expect(applyCalendar).toHaveBeenCalledTimes(2);
      const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
      expect(logged).toContain("boom");
      expect(logged).not.toContain("private-abc123");
      expect(logged).not.toContain("Secret");
      calendar.dispose();
    });

    it("is disabled without a config file, silently", async () => {
      const { calendar, fetchFn } = calendarFor(ics());
      await calendar.poll();
      expect(fetchFn).not.toHaveBeenCalled();
      expect(applyCalendar).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("is disabled with an empty list, silently", async () => {
      writeConfig([]);
      const { calendar, fetchFn } = calendarFor(ics());
      await calendar.poll();
      expect(fetchFn).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("warns once about a malformed config", async () => {
      writeFileSync(configPath, "{not json");
      const { calendar, fetchFn } = calendarFor(ics());
      await calendar.poll();
      await calendar.poll();
      expect(fetchFn).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it("starts a block that begins within ten minutes on time", async () => {
      writeConfig([URL_A]);
      const { calendar } = calendarFor(
        ics(vevent({ start: "20261027T120500Z", end: "20261027T130000Z", attendees: [other] })),
      );
      await calendar.poll();
      expect(applyCalendar).not.toHaveBeenCalled();

      setNow("2026-10-27T12:05:00Z");
      await vi.advanceTimersByTimeAsync(5 * MINUTE);
      expect(applyCalendar).toHaveBeenCalledTimes(1);
      calendar.dispose();
    });

    it("clears the precision timer on dispose", async () => {
      writeConfig([URL_A]);
      const { calendar } = calendarFor(
        ics(vevent({ start: "20261027T120500Z", end: "20261027T130000Z", attendees: [other] })),
      );
      await calendar.poll();
      calendar.dispose();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
