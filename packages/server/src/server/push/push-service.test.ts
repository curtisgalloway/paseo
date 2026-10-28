import type pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PushService } from "./push-service.js";

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  return logger as unknown as pino.Logger;
}

async function sentMessages(tier?: "warning" | "caution" | "advisory") {
  const fetchMock = vi.fn(
    async (_url: string, _init: { body: string }) =>
      new Response(JSON.stringify({ data: [{ status: "ok" }] }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const service = new PushService(createLogger(), () => undefined);
  await service.sendPush(["ExponentPushToken[a]"], { title: "t", body: "b", tier });
  return JSON.parse(fetchMock.mock.calls[0][1].body) as Array<{ sound?: string }>;
}

describe("PushService sound", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("plays the default sound only for warning-tier pushes", async () => {
    expect((await sentMessages("warning"))[0].sound).toBe("default");
  });

  it("is silent for caution, advisory, and untiered pushes", async () => {
    expect((await sentMessages("caution"))[0].sound).toBeUndefined();
    expect((await sentMessages("advisory"))[0].sound).toBeUndefined();
    expect((await sentMessages())[0].sound).toBeUndefined();
  });
});
