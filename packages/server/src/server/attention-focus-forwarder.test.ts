import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttentionFocus } from "./attention-focus.js";
import { AttentionFocusForwarder } from "./attention-focus-forwarder.js";
import type { AcceptedHost } from "./connected-hosts/index.js";

const MINUTE = 60_000;

function fakeHost(serverId: string, supportsFocus: boolean) {
  const setAttentionFocus = vi.fn(async () => ({}));
  const host = {
    registrationId: `hst_${serverId}`,
    serverId,
    client: {
      getLastServerInfoMessage: () => ({ features: supportsFocus ? { attentionFocus: true } : {} }),
      setAttentionFocus,
    },
  } as unknown as AcceptedHost;
  return { host, setAttentionFocus };
}

describe("AttentionFocusForwarder", () => {
  let dir: string;
  let accepted: AcceptedHost[];
  let acceptedListener: ((host: AcceptedHost) => void) | null;
  let applyingForwarded: boolean;
  let focus: AttentionFocus;
  let forwarder: AttentionFocusForwarder;
  const warn = vi.fn();
  const logger = { warn } as unknown as pino.Logger;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T12:00:00.000Z"));
    dir = mkdtempSync(join(tmpdir(), "paseo-focus-forward-"));
    accepted = [];
    acceptedListener = null;
    applyingForwarded = false;
    warn.mockClear();
    forwarder = new AttentionFocusForwarder({
      hosts: {
        acceptedHosts: () => accepted,
        onHostAccepted: (listener) => {
          acceptedListener = listener;
          return () => {
            acceptedListener = null;
          };
        },
      },
      getState: () => focus.getState(),
      logger,
    });
    focus = new AttentionFocus({
      filePath: join(dir, "focus.json"),
      logger,
      onChange: (state) => forwarder.onFocusChange(state, { forwarded: applyingForwarded }),
      onEnded: () => {},
    });
    focus.start();
  });

  afterEach(() => {
    focus.dispose();
    forwarder.dispose();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("forwards a manual start with the remaining duration, and the end as null", () => {
    const withFocus = fakeHost("a", true);
    accepted = [withFocus.host];

    focus.set(25 * MINUTE);
    expect(withFocus.setAttentionFocus).toHaveBeenLastCalledWith(25 * MINUTE, undefined, {
      forwarded: true,
    });

    focus.set(null);
    expect(withFocus.setAttentionFocus).toHaveBeenLastCalledWith(null, undefined, {
      forwarded: true,
    });
    expect(withFocus.setAttentionFocus).toHaveBeenCalledTimes(2);
  });

  it("does not forward to a host without the focus feature", () => {
    const withFocus = fakeHost("a", true);
    const without = fakeHost("b", false);
    accepted = [withFocus.host, without.host];

    focus.set(10 * MINUTE);

    expect(withFocus.setAttentionFocus).toHaveBeenCalledTimes(1);
    expect(without.setAttentionFocus).not.toHaveBeenCalled();
  });

  it("forwards a calendar start and a calendar extension", () => {
    const host = fakeHost("a", true);
    accepted = [host.host];
    const now = Date.now();

    focus.applyCalendar({
      until: new Date(now + 30 * MINUTE),
      startedAt: new Date(now),
      eventKey: "meeting",
    });
    expect(host.setAttentionFocus).toHaveBeenLastCalledWith(30 * MINUTE, undefined, {
      forwarded: true,
    });

    focus.applyCalendar({
      until: new Date(now + 45 * MINUTE),
      startedAt: new Date(now),
      eventKey: "meeting",
    });
    expect(host.setAttentionFocus).toHaveBeenLastCalledWith(45 * MINUTE, undefined, {
      forwarded: true,
    });
    expect(host.setAttentionFocus).toHaveBeenCalledTimes(2);
  });

  it("forwards the end when focus expires", () => {
    const host = fakeHost("a", true);
    accepted = [host.host];
    focus.set(5 * MINUTE);
    host.setAttentionFocus.mockClear();

    vi.advanceTimersByTime(5 * MINUTE + 1);

    expect(host.setAttentionFocus).toHaveBeenCalledTimes(1);
    expect(host.setAttentionFocus).toHaveBeenCalledWith(null, undefined, { forwarded: true });
  });

  it("does not forward held-count changes inside one period", () => {
    const host = fakeHost("a", true);
    accepted = [host.host];
    focus.set(25 * MINUTE);
    host.setAttentionFocus.mockClear();

    focus.hold({
      terminalId: "term-1",
      title: "bash",
      reason: "permission",
      awaitingInput: true,
      at: new Date().toISOString(),
    });

    expect(host.setAttentionFocus).not.toHaveBeenCalled();
  });

  it("does not forward a change that arrived from another daemon", () => {
    const host = fakeHost("a", true);
    accepted = [host.host];

    applyingForwarded = true;
    focus.set(25 * MINUTE);
    focus.set(null);
    applyingForwarded = false;

    expect(host.setAttentionFocus).not.toHaveBeenCalled();
  });

  it("pushes the active state to a host when it connects or reconnects", () => {
    focus.set(20 * MINUTE);
    vi.advanceTimersByTime(5 * MINUTE);
    const host = fakeHost("a", true);

    acceptedListener?.(host.host);

    expect(host.setAttentionFocus).toHaveBeenCalledWith(15 * MINUTE, undefined, {
      forwarded: true,
    });
  });

  it("sends nothing on connect when focus is inactive or the host lacks the feature", () => {
    const idle = fakeHost("a", true);
    acceptedListener?.(idle.host);
    expect(idle.setAttentionFocus).not.toHaveBeenCalled();

    focus.set(20 * MINUTE);
    const without = fakeHost("b", false);
    acceptedListener?.(without.host);
    expect(without.setAttentionFocus).not.toHaveBeenCalled();
  });

  it("logs a warning and carries on when a host rejects the request", async () => {
    const failing = fakeHost("a", true);
    failing.setAttentionFocus.mockRejectedValueOnce(new Error("offline"));
    const healthy = fakeHost("b", true);
    accepted = [failing.host, healthy.host];

    focus.set(10 * MINUTE);
    await vi.advanceTimersByTimeAsync(0);

    expect(healthy.setAttentionFocus).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "a" }),
      "Failed to forward focus to connected host",
    );
  });
});
