import { createWorkspaceRuntimeStore } from "./workspace-runtime-store/index.js";
import { SessionDelivery } from "./session/owned-subscriptions/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttentionFocus } from "./attention-focus.js";
import type { Server as HTTPServer } from "http";
import type pino from "pino";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type { DownloadTokenStore } from "./file-download/token-store.js";
import type { DaemonConfigStore } from "./daemon-config-store.js";
import type { ScheduleService } from "./schedule/service.js";
import type { CheckoutDiffManager } from "./checkout-diff-manager.js";
import { asInternals, createStub } from "./test-utils/class-mocks.js";
import { createProviderSnapshotManagerStub } from "./test-utils/session-stubs.js";
import type { PushNotificationSender, PushPayload } from "./push/index.js";
import type { WorkspaceAutoName } from "./workspace-auto-name.js";

const WORKSPACE_ID = "workspace-1";

const wsModuleMock = vi.hoisted(() => {
  class MockWebSocketServer {
    readonly handlers = new Map<string, (...args: unknown[]) => void>();

    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(event, handler);
      return this;
    }

    close() {
      // no-op
    }
  }

  return { MockWebSocketServer };
});

vi.mock("ws", () => ({
  WebSocketServer: wsModuleMock.MockWebSocketServer,
}));

const tierOverride = vi.hoisted(() => ({ value: null as string | null }));

vi.mock("./agent-attention-policy.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./agent-attention-policy.js")>();
  return {
    ...original,
    attentionTier: (input: Parameters<typeof original.attentionTier>[0]) =>
      tierOverride.value ?? original.attentionTier(input),
  };
});

vi.mock("./session.js", () => ({
  Session: function Session() {
    return {};
  },
}));

import { VoiceAssistantWebSocketServer } from "./websocket-server.js";

interface WebSocketServerInternals {
  sessions: Map<unknown, unknown>;
  attentionFocus: AttentionFocus;
  broadcastAgentAttention(params: {
    agentId: string;
    reason: string;
    preview?: string;
    providerId?: string;
    timestamp?: string;
  }): Promise<void>;
}

function createLogger() {
  const logger = {
    child: vi.fn(() => logger),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

function createWorkspaceAutoNameStub(): WorkspaceAutoName {
  return createStub<WorkspaceAutoName>({
    scheduleForWorktree: () => {},
    scheduleForDirectory: () => {},
  });
}

class RecordingPushNotificationSender implements PushNotificationSender {
  readonly sent: PushPayload[] = [];

  async send(payload: PushPayload): Promise<void> {
    this.sent.push(payload);
  }
}

function createServer(
  agentManagerOverrides?: Record<string, unknown>,
  paseoHome = "/tmp/paseo-test",
) {
  const pushNotifications = new RecordingPushNotificationSender();
  const agentManager = {
    subscribe: vi.fn(() => () => {}),
    setAgentAttentionCallback: vi.fn(),
    setAgentAttentionResolvedCallback: vi.fn(),
    getAgent: vi.fn(() => ({ workspaceId: WORKSPACE_ID, pendingPermissions: new Map() })),
    getLastAssistantMessage: vi.fn(async () => null),
    getMetricsSnapshot: vi.fn(() => ({
      total: 0,
      byLifecycle: {},
      withActiveForegroundTurn: 0,
      timelineStats: {
        totalItems: 0,
        maxItemsPerAgent: 0,
      },
    })),
    ...agentManagerOverrides,
  };
  const daemonConfigStore = {
    onApply: vi.fn(() => () => {}),
    onChange: vi.fn(() => () => {}),
  };

  const server = new VoiceAssistantWebSocketServer(
    createStub<HTTPServer>({}),
    createStub<pino.Logger>(createLogger()),
    "srv-test",
    createStub<AgentManager>(agentManager),
    createStub<AgentStorage>({}),
    createStub<DownloadTokenStore>({}),
    paseoHome,
    createStub<DaemonConfigStore>(daemonConfigStore),
    null,
    { allowedOrigins: new Set() },
    createWorkspaceAutoNameStub(),
    createWorkspaceRuntimeStore(),
    undefined,
    undefined,
    undefined,
    undefined,
    "1.2.3-test",
    undefined,
    undefined,
    undefined,
    createStub<ScheduleService>({}),
    createStub<CheckoutDiffManager>({
      subscribe: vi.fn(),
      scheduleRefreshForCwd: vi.fn(),
      getMetrics: vi.fn(() => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
      })),
      dispose: vi.fn(),
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    pushNotifications,
    createProviderSnapshotManagerStub().manager,
  );

  return { server, agentManager, pushNotifications };
}

function createOpenSocket() {
  return {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
  };
}

function createSessionWithActivity(
  activity: {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    lastActivityAt: Date;
    appVisible: boolean;
    appVisibilityChangedAt?: Date;
  } | null,
  subscribed = true,
) {
  return {
    getClientActivity: vi.fn(() => activity),
    supports: () => false,
    supportsForSource: () => false,
    subscribesToAgent: vi.fn(async () => subscribed),
  };
}

function connectClient(
  server: VoiceAssistantWebSocketServer,
  activity: {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    lastActivityAt: Date;
    appVisible: boolean;
    appVisibilityChangedAt?: Date;
  } | null,
  options: { subscribed?: boolean } = {},
) {
  const ws = createOpenSocket();
  const delivery = new SessionDelivery(() => {});
  delivery.attach(ws, false);
  asInternals<WebSocketServerInternals>(server).sessions.set(ws, {
    kind: "trusted",
    session: {
      ...createSessionWithActivity(activity, options.subscribed ?? true),
      delivery,
      wantsSourceNotification: () => true,
      wantsSourceEvent: () => false,
    },
    clientId: "client-test",
    appVersion: null,
    connectionLogger: createLogger(),
    sockets: new Set([ws]),
    externalDisconnectCleanupTimeout: null,
  });
  return ws;
}

function readAttentionRequiredMessage(ws: ReturnType<typeof createOpenSocket>) {
  const rawMessage = ws.send.mock.calls[0]?.[0];
  expect(typeof rawMessage).toBe("string");
  if (typeof rawMessage !== "string") throw new Error("Expected string WebSocket frame");
  const message = JSON.parse(rawMessage);
  expect(message.type).toBe("session");
  expect(message.message.type).toBe("agent_stream");
  expect(message.message.payload.event.type).toBe("attention_required");
  return message.message.payload.event;
}

describe("VoiceAssistantWebSocketServer notification payloads", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not emit attention or include presence without an agent-directory subscription", async () => {
    const { server, pushNotifications } = createServer();
    const now = new Date();
    const unsubscribed = connectClient(
      server,
      {
        deviceType: "web",
        appVisible: true,
        focusedAgentId: "agent-1",
        lastActivityAt: now,
      },
      { subscribed: false },
    );

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
      awaitingInput: true,
    });

    expect(unsubscribed.send).not.toHaveBeenCalled();
    expect(pushNotifications.sent).toHaveLength(1);
  });

  it("uses assistant preview text for push notifications with markdown removed", async () => {
    const getLastAssistantMessage = vi.fn(
      async () => "**Done**. Updated `README.md` and [link](https://example.com).",
    );
    const { server, pushNotifications } = createServer({
      getAgent: vi.fn(() => ({
        config: { title: null },
        cwd: "/tmp/worktree",
        workspaceId: WORKSPACE_ID,
        pendingPermissions: new Map(),
      })),
      getLastAssistantMessage,
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
      awaitingInput: true,
    });

    expect(pushNotifications.sent).toEqual([
      {
        title: "Agent is waiting for you",
        body: "Done. Updated README.md and link.",
        tier: "caution",
        data: {
          serverId: "srv-test",
          workspaceId: WORKSPACE_ID,
          agentId: "agent-1",
          reason: "finished",
        },
      },
    ]);
    expect(getLastAssistantMessage).toHaveBeenCalledWith("agent-1");
  });

  it("sends push notifications regardless of UI label presence", async () => {
    const getLastAssistantMessage = vi.fn(async () => "Done.");
    const { server, pushNotifications } = createServer({
      getAgent: vi.fn(() => ({
        config: { title: null },
        cwd: "/tmp/worktree",
        workspaceId: WORKSPACE_ID,
        labels: {},
        pendingPermissions: new Map(),
      })),
      getLastAssistantMessage,
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-2",
      provider: "claude",
      reason: "finished",
      awaitingInput: true,
    });

    expect(pushNotifications.sent).toHaveLength(1);
    expect(getLastAssistantMessage).toHaveBeenCalledWith("agent-2");
  });

  it("routes a hidden stale focused browser tab's notification to the present Electron web client", async () => {
    const { server, pushNotifications } = createServer();
    const nowMs = Date.now();
    const electronWs = connectClient(server, {
      deviceType: "web",
      appVisible: false,
      focusedAgentId: "agent-Y",
      lastActivityAt: new Date(nowMs - 5_000),
    });
    const firefoxWs = connectClient(server, {
      deviceType: "web",
      appVisible: false,
      focusedAgentId: "agent-X",
      lastActivityAt: new Date(nowMs - 300_000),
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-X",
      provider: "claude",
      reason: "finished",
      awaitingInput: true,
    });

    expect(readAttentionRequiredMessage(electronWs).shouldNotify).toBe(true);
    expect(readAttentionRequiredMessage(firefoxWs).shouldNotify).toBe(false);
    expect(pushNotifications.sent).toEqual([]);
  });

  it("pushes non-error attention when the only connected client has never sent a heartbeat", async () => {
    const { server, pushNotifications } = createServer();
    const ws = connectClient(server, null);

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-no-heartbeat",
      provider: "claude",
      reason: "finished",
      awaitingInput: true,
    });

    expect(readAttentionRequiredMessage(ws).shouldNotify).toBe(false);
    expect(pushNotifications.sent).toHaveLength(1);
  });

  it("pushes error attention when the only connected client has never sent a heartbeat", async () => {
    const { server, pushNotifications } = createServer();
    const ws = connectClient(server, null);

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-no-heartbeat",
      provider: "claude",
      reason: "error",
    });

    expect(readAttentionRequiredMessage(ws).shouldNotify).toBe(false);
    expect(pushNotifications.sent).toHaveLength(1);
    expect(pushNotifications.sent[0]).toMatchObject({ tier: "caution" });
  });

  it("keeps a finished turn that asks nothing silent: no notify, no push", async () => {
    const { server, pushNotifications } = createServer();
    const present = connectClient(server, {
      deviceType: "web",
      appVisible: false,
      focusedAgentId: "other",
      lastActivityAt: new Date(),
    });
    const away = connectClient(server, null);

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-quiet",
      provider: "claude",
      reason: "finished",
    });

    expect(readAttentionRequiredMessage(present).shouldNotify).toBe(false);
    expect(readAttentionRequiredMessage(away).shouldNotify).toBe(false);
    expect(pushNotifications.sent).toEqual([]);
  });

  it("notifies the present client when a finished turn ends with a question", async () => {
    const { server, pushNotifications } = createServer();
    const present = connectClient(server, {
      deviceType: "web",
      appVisible: false,
      focusedAgentId: "other",
      lastActivityAt: new Date(),
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-asking",
      provider: "claude",
      reason: "finished",
      awaitingInput: true,
    });

    expect(readAttentionRequiredMessage(present).shouldNotify).toBe(true);
    expect(pushNotifications.sent).toEqual([]);
  });
});

describe("VoiceAssistantWebSocketServer focus periods", () => {
  const dirs: string[] = [];

  function createFocusServer(agent: Record<string, unknown> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "paseo-focus-test-"));
    dirs.push(dir);
    const created = createServer(
      {
        getAgent: vi.fn(() => ({
          config: { title: "Build bot" },
          provider: "claude",
          workspaceId: WORKSPACE_ID,
          pendingPermissions: new Map(),
          ...agent,
        })),
      },
      dir,
    );
    return { ...created, internals: asInternals<WebSocketServerInternals>(created.server) };
  }

  function sentMessages(ws: ReturnType<typeof createOpenSocket>) {
    return ws.send.mock.calls.map((call) => JSON.parse(call[0] as string).message);
  }

  afterEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
    tierOverride.value = null;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("holds a caution event: delivered without notify or push, counted once per agent", async () => {
    const { server, internals, pushNotifications } = createFocusServer();
    const present = connectClient(server, {
      deviceType: "web",
      appVisible: false,
      focusedAgentId: "other",
      lastActivityAt: new Date(),
    });
    internals.attentionFocus.set(25 * 60_000);

    for (const reason of ["permission", "finished"] as const) {
      await internals.broadcastAgentAttention({
        agentId: "agent-1",
        provider: "claude",
        reason,
        awaitingInput: true,
      });
    }

    const events = sentMessages(present).map((message) => message.payload.event);
    expect(events.map((event) => event.type)).toEqual(["attention_required", "attention_required"]);
    expect(events.map((event) => event.shouldNotify)).toEqual([false, false]);
    expect(pushNotifications.sent).toEqual([]);
    expect(internals.attentionFocus.getState().heldCount).toBe(1);
  });

  it("lets a warning break through focus", async () => {
    const { server, internals } = createFocusServer();
    const present = connectClient(server, {
      deviceType: "web",
      appVisible: false,
      focusedAgentId: "other",
      lastActivityAt: new Date(),
    });
    internals.attentionFocus.set(25 * 60_000);
    tierOverride.value = "warning";

    await internals.broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "permission",
    });

    const [event] = sentMessages(present).map((message) => message.payload.event);
    expect(event.shouldNotify).toBe(true);
    expect(internals.attentionFocus.getState().heldCount).toBe(0);
  });

  it("does not hold advisory events", async () => {
    const { internals } = createFocusServer();
    internals.attentionFocus.set(25 * 60_000);

    await internals.broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
    });

    expect(internals.attentionFocus.getState().heldCount).toBe(0);
  });

  it("delivers one summary through caution routing when focus ends", async () => {
    const { server, internals, pushNotifications } = createFocusServer();
    const present = connectClient(server, {
      deviceType: "web",
      appVisible: false,
      focusedAgentId: "other",
      lastActivityAt: new Date(),
    });
    internals.attentionFocus.set(25 * 60_000);
    await internals.broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "permission",
    });
    present.send.mockClear();

    internals.attentionFocus.set(null);
    await vi.waitFor(() => expect(present.send).toHaveBeenCalled());

    const events = sentMessages(present).map((message) => message.payload.event);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "attention_required",
      shouldNotify: true,
      notification: {
        title: "Focus ended: 1 agent needs you",
        body: "Build bot",
        tier: "caution",
        data: { agentId: "agent-1", workspaceId: WORKSPACE_ID },
      },
    });
    expect(pushNotifications.sent).toEqual([]);
  });

  it("pushes the summary when no client is present", async () => {
    const { internals, pushNotifications } = createFocusServer();
    internals.attentionFocus.set(25 * 60_000);
    await internals.broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "error",
    });

    internals.attentionFocus.set(null);
    await vi.waitFor(() => expect(pushNotifications.sent).toHaveLength(1));

    expect(pushNotifications.sent[0]).toMatchObject({
      title: "Focus ended: 1 agent needs you",
      tier: "caution",
    });
  });

  it("sends nothing when focus ends with nothing held", async () => {
    const { internals, pushNotifications } = createFocusServer();
    internals.attentionFocus.set(25 * 60_000);
    internals.attentionFocus.set(null);
    await Promise.resolve();
    expect(pushNotifications.sent).toEqual([]);
  });
});

describe("VoiceAssistantWebSocketServer attention log", () => {
  const dirs: string[] = [];

  function createLoggedServer() {
    const dir = mkdtempSync(join(tmpdir(), "paseo-attention-log-test-"));
    dirs.push(dir);
    const created = createServer(
      {
        getAgent: vi.fn(() => ({
          config: { title: "Secret title" },
          provider: "claude",
          workspaceId: WORKSPACE_ID,
          pendingPermissions: new Map(),
        })),
      },
      dir,
    );
    const readLog = () =>
      readFileSync(join(dir, "attention-log.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    return {
      ...created,
      internals: asInternals<WebSocketServerInternals>(created.server),
      readLog,
    };
  }

  const presentAway = {
    deviceType: "web" as const,
    appVisible: false,
    focusedAgentId: "other",
    lastActivityAt: new Date(),
  };

  afterEach(() => {
    vi.clearAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("logs none for advisory", async () => {
    const { server, internals, readLog } = createLoggedServer();
    connectClient(server, presentAway);
    await internals.broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
    });
    expect(readLog()).toEqual([
      expect.objectContaining({
        kind: "attention",
        schemaVersion: 1,
        agentId: "agent-1",
        workspaceId: WORKSPACE_ID,
        provider: "claude",
        reason: "finished",
        awaitingInput: false,
        tier: "advisory",
        delivery: "none",
      }),
    ]);
    expect(JSON.stringify(readLog())).not.toContain("Secret title");
  });

  it("logs in_app for caution with a present client", async () => {
    const { server, internals, readLog } = createLoggedServer();
    connectClient(server, presentAway);
    await internals.broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "error",
    });
    expect(readLog()[0]).toMatchObject({ tier: "caution", delivery: "in_app" });
  });

  it("logs push for caution with nobody present", async () => {
    const { internals, readLog } = createLoggedServer();
    await internals.broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "error",
    });
    expect(readLog()[0]).toMatchObject({ tier: "caution", delivery: "push" });
  });

  it("logs held during focus", async () => {
    const { server, internals, readLog } = createLoggedServer();
    connectClient(server, presentAway);
    internals.attentionFocus.set(25 * 60_000);
    await internals.broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "error",
    });
    expect(readLog()[0]).toMatchObject({ tier: "caution", delivery: "held" });
  });

  it("logs suppressed_focused when the user is already looking at the agent", async () => {
    const { server, internals, readLog } = createLoggedServer();
    connectClient(server, { ...presentAway, appVisible: true, focusedAgentId: "agent-1" });
    await internals.broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "error",
    });
    expect(readLog()[0]).toMatchObject({ tier: "caution", delivery: "suppressed_focused" });
  });
});
