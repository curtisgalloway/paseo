import { readFileSync } from "node:fs";
import ICAL from "ical.js";
import type pino from "pino";

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30 * 1000;
const WINDOW_BEFORE_MS = 12 * 60 * 60 * 1000;
const WINDOW_AFTER_MS = 24 * 60 * 60 * 1000;
const PRECISION_LOOKAHEAD_MS = 10 * 60 * 1000;
// Slack past the window when walking a series, so an override moved earlier is still found.
const SERIES_SLACK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SERIES_ITERATIONS = 5000;

export interface CalendarBlock {
  until: number;
  startedAt: number;
  eventKey: string;
}

export interface CalendarFocusTarget {
  applyCalendar(block: { until: Date; startedAt: Date; eventKey: string }): void;
}

type FetchLike = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

interface AttentionCalendarOptions {
  configPath: string;
  logger: pino.Logger;
  focus: CalendarFocusTarget;
  fetchFn?: FetchLike;
  now?: () => number;
}

interface FeedEvents {
  // One entry per UID; `master` is absent when the feed holds only overrides.
  series: Array<{ master: ICAL.Event | null; overrides: ICAL.Event[] }>;
  eventCount: number;
}

interface Occurrence {
  start: number;
  end: number;
  key: string;
}

/**
 * Starts focus periods from private iCal feeds. The config file lists the feed URLs; every
 * poll rereads it, fetches each feed, and keeps the last good parse of a feed that fails.
 * Never logs event content or the URL: only counts and error messages.
 */
export class AttentionCalendar {
  private readonly feeds = new Map<string, FeedEvents>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private precisionTimer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private warnedMalformed = false;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;

  constructor(private readonly options: AttentionCalendarOptions) {
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
  }

  start(): void {
    void this.poll();
    this.interval = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    this.interval.unref?.();
  }

  dispose(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.clearPrecisionTimer();
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const urls = this.readUrls();
      for (const known of this.feeds.keys()) {
        if (!urls.includes(known)) this.feeds.delete(known);
      }
      if (urls.length === 0) {
        this.clearPrecisionTimer();
        return;
      }
      for (const url of urls) {
        await this.refreshFeed(url);
      }
      this.evaluate();
    } finally {
      this.polling = false;
    }
  }

  // Recomputes the current block from the cached events and applies it; also arms the timer
  // for a block that starts within the next few minutes.
  evaluate(): void {
    this.clearPrecisionTimer();
    const now = this.now();
    let eventCount = 0;
    const occurrences: Occurrence[] = [];
    for (const [url, feed] of this.feeds) {
      eventCount += feed.eventCount;
      const owner = ownerEmail(url);
      if (owner === null) continue;
      occurrences.push(...qualifyingOccurrences(feed, owner, now));
    }
    const blocks = mergeBlocks(occurrences);
    this.options.logger.debug(
      { events: eventCount, qualifying: occurrences.length },
      "Calendar focus evaluated",
    );
    const current = blocks.find((block) => block.startedAt <= now && now < block.until);
    if (current) {
      this.options.focus.applyCalendar({
        until: new Date(current.until),
        startedAt: new Date(current.startedAt),
        eventKey: current.eventKey,
      });
    }
    const next = blocks.find(
      (block) => block.startedAt > now && block.startedAt - now <= PRECISION_LOOKAHEAD_MS,
    );
    if (next) {
      this.precisionTimer = setTimeout(() => {
        this.precisionTimer = null;
        this.evaluate();
      }, next.startedAt - now);
      this.precisionTimer.unref?.();
    }
  }

  private clearPrecisionTimer(): void {
    if (this.precisionTimer) {
      clearTimeout(this.precisionTimer);
      this.precisionTimer = null;
    }
  }

  private readUrls(): string[] {
    let raw: string;
    try {
      raw = readFileSync(this.options.configPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.warnMalformed((err as Error).message);
      }
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as { icalUrls?: unknown };
      if (
        !parsed ||
        !Array.isArray(parsed.icalUrls) ||
        !parsed.icalUrls.every((url) => typeof url === "string")
      ) {
        throw new Error("icalUrls must be an array of strings");
      }
      this.warnedMalformed = false;
      const urls = parsed.icalUrls as string[];
      for (const url of urls) {
        if (ownerEmail(url) === null) {
          this.options.logger.warn("Calendar feed ignored: no owner email in its URL path");
        }
      }
      return urls;
    } catch (err) {
      this.warnMalformed((err as Error).message);
      return [];
    }
  }

  private warnMalformed(message: string): void {
    if (this.warnedMalformed) return;
    this.warnedMalformed = true;
    this.options.logger.warn({ error: message }, "Calendar focus disabled: bad config file");
  }

  private async refreshFeed(url: string): Promise<void> {
    try {
      const response = await this.fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      this.feeds.set(url, parseFeed(await response.text()));
    } catch (err) {
      // The error message of fetch/parse failures can embed the URL; redact it.
      const message = String((err as Error)?.message ?? err)
        .split(url)
        .join("<feed>");
      this.options.logger.warn({ error: message }, "Calendar feed refresh failed; keeping last");
    }
  }
}

function ownerEmail(url: string): string | null {
  try {
    const segment = new URL(url).pathname.split("/")[3];
    if (!segment) return null;
    return decodeURIComponent(segment).trim().toLowerCase() || null;
  } catch {
    return null;
  }
}

function parseFeed(text: string): FeedEvents {
  const root = new ICAL.Component(ICAL.parse(text));
  for (const zone of root.getAllSubcomponents("vtimezone")) {
    ICAL.TimezoneService.register(zone);
  }
  const byUid = new Map<string, { master: ICAL.Component | null; overrides: ICAL.Component[] }>();
  const components = root.getAllSubcomponents("vevent");
  for (const component of components) {
    const uid = String(component.getFirstPropertyValue("uid") ?? "");
    const entry = byUid.get(uid) ?? { master: null, overrides: [] };
    if (component.hasProperty("recurrence-id")) {
      entry.overrides.push(component);
    } else {
      entry.master = component;
    }
    byUid.set(uid, entry);
  }
  const series = [...byUid.values()].map((entry) => {
    const master = entry.master ? new ICAL.Event(entry.master) : null;
    const overrides = entry.overrides.map((component) => new ICAL.Event(component));
    if (master) {
      for (const override of overrides) master.relateException(override);
    }
    return { master, overrides };
  });
  return { series, eventCount: components.length };
}

function qualifyingOccurrences(feed: FeedEvents, owner: string, now: number): Occurrence[] {
  const from = now - WINDOW_BEFORE_MS;
  const to = now + WINDOW_AFTER_MS;
  const found: Occurrence[] = [];
  const consider = (event: ICAL.Event, uid: string, start: number, end: number): void => {
    if (end <= from || start >= to || end <= start) return;
    if (event.startDate.isDate) return;
    if (!qualifies(event, owner)) return;
    found.push({ start, end, key: `${uid}|${new Date(start).toISOString()}` });
  };

  for (const { master, overrides } of feed.series) {
    if (!master) {
      for (const override of overrides) {
        consider(override, override.uid, instant(override.startDate), instant(override.endDate));
      }
      continue;
    }
    if (!master.isRecurring()) {
      consider(master, master.uid, instant(master.startDate), instant(master.endDate));
      continue;
    }
    const iterator = master.iterator();
    for (let i = 0; i < MAX_SERIES_ITERATIONS; i += 1) {
      const next = iterator.next();
      if (!next) break;
      if (instant(next) > to + SERIES_SLACK_MS) break;
      const details = master.getOccurrenceDetails(next);
      consider(details.item, master.uid, instant(details.startDate), instant(details.endDate));
    }
  }
  return found;
}

function instant(time: ICAL.Time): number {
  return time.toJSDate().getTime();
}

function emailOf(value: unknown): string {
  return String(value ?? "")
    .replace(/^mailto:/i, "")
    .trim()
    .toLowerCase();
}

function qualifies(event: ICAL.Event, owner: string): boolean {
  const component = event.component;
  if (String(component.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED") {
    return false;
  }
  const summary = (event.summary ?? "").trim().toLowerCase();
  if (summary === "focus" || summary.includes("[focus]")) return true;

  const transparency = String(component.getFirstPropertyValue("transp") ?? "OPAQUE");
  if (transparency.toUpperCase() !== "OPAQUE") return false;

  let hasOther = false;
  for (const attendee of event.attendees) {
    const email = emailOf(attendee.getFirstValue());
    if (email === owner) {
      const status = String(attendee.getParameter("partstat") ?? "").toUpperCase();
      if (status === "DECLINED") return false;
    } else if (email) {
      hasOther = true;
    }
  }
  return hasOther;
}

// Merges overlapping or back-to-back occurrences; the key is the first occurrence's.
function mergeBlocks(occurrences: Occurrence[]): CalendarBlock[] {
  const sorted = [...occurrences].sort((a, b) => a.start - b.start);
  const blocks: CalendarBlock[] = [];
  for (const occurrence of sorted) {
    const last = blocks[blocks.length - 1];
    if (last && occurrence.start <= last.until) {
      last.until = Math.max(last.until, occurrence.end);
    } else {
      blocks.push({ startedAt: occurrence.start, until: occurrence.end, eventKey: occurrence.key });
    }
  }
  return blocks;
}
