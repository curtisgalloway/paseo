import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";
import { claudeProjectDirSync } from "./project-dir.js";

const SESSION_CWD = "/tmp/paseo-claude-renamed-import";

interface ClaudeTranscriptRecord {
  [key: string]: unknown;
}

let configDir: string;
let previousConfigDir: string | undefined;

interface UserRecordInput {
  sessionId: string;
  content: string;
  permissionMode?: string;
  isSidechain?: boolean;
}

interface WriteSessionInput {
  sessionId: string;
  records: ClaudeTranscriptRecord[];
}

function userRecord({
  sessionId,
  content,
  permissionMode,
  isSidechain = false,
}: UserRecordInput): ClaudeTranscriptRecord {
  return {
    isSidechain,
    type: "user",
    message: { role: "user", content },
    cwd: SESSION_CWD,
    sessionId,
    ...(permissionMode ? { permissionMode } : {}),
  };
}

async function writeSession({ sessionId, records }: WriteSessionInput): Promise<void> {
  const projectDir = claudeProjectDirSync(SESSION_CWD, { configDir });
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, `${sessionId}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
}

// Importing replays the transcript from disk, so this drives the real resume
// path without starting Claude Code.
async function importSession(sessionId: string) {
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: async () => "/test/claude/bin",
  });
  return client.importSession(
    { providerHandleId: sessionId, cwd: SESSION_CWD },
    {
      config: { provider: "claude", cwd: SESSION_CWD },
      storedConfig: { provider: "claude", cwd: SESSION_CWD },
    },
  );
}

beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-claude-renamed-"));
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
});

afterEach(async () => {
  if (previousConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  }
  await fs.rm(configDir, { recursive: true, force: true });
});

describe("importing a renamed Claude session", () => {
  test.each(["provider", "launch"])(
    "reads the rename from the %s config directory used for history",
    async (source) => {
      const sessionId = "provider-directory-rename";
      const providerConfigDir = path.join(configDir, "provider");
      const projectDir = claudeProjectDirSync(SESSION_CWD, { configDir: providerConfigDir });
      await fs.mkdir(projectDir, { recursive: true });
      await fs.writeFile(
        path.join(projectDir, `${sessionId}.jsonl`),
        [
          userRecord({ sessionId, content: "Review this project" }),
          { type: "custom-title", customTitle: "My research session", sessionId },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n") + "\n",
      );
      const client = new ClaudeAgentClient({
        logger: createTestLogger(),
        runtimeSettings:
          source === "provider" ? { env: { CLAUDE_CONFIG_DIR: providerConfigDir } } : undefined,
        resolveBinary: async () => "/test/claude/bin",
      });
      const imported = await client.importSession(
        { providerHandleId: sessionId, cwd: SESSION_CWD },
        {
          config: { provider: "claude", cwd: SESSION_CWD },
          storedConfig: { provider: "claude", cwd: SESSION_CWD },
          launchContext:
            source === "launch" ? { env: { CLAUDE_CONFIG_DIR: providerConfigDir } } : undefined,
        },
      );
      expect(imported.timeline.map((entry) => entry.item)).toContainEqual(
        expect.objectContaining({ type: "user_message", text: "Review this project" }),
      );
      expect(imported.config.title).toBe("My research session");
    },
  );

  test("names the imported agent after a /rename", async () => {
    const sessionId = "renamed-session";
    await writeSession({
      sessionId,
      records: [
        userRecord({ sessionId, content: "Review this project" }),
        { type: "custom-title", customTitle: "My research session", sessionId },
      ],
    });

    const imported = await importSession(sessionId);

    expect(imported.config.title).toBe("My research session");
  });

  test("uses the last rename when the session was renamed more than once", async () => {
    const sessionId = "renamed-twice";
    await writeSession({
      sessionId,
      records: [
        userRecord({ sessionId, content: "Move invoices to the new schema" }),
        { type: "custom-title", customTitle: "invoices", sessionId },
        { type: "custom-title", customTitle: "billing rework", sessionId },
      ],
    });

    const imported = await importSession(sessionId);

    expect(imported.config.title).toBe("billing rework");
  });

  test("preserves a rename when the first prompt was /model", async () => {
    const sessionId = "model-first";
    await writeSession({
      sessionId,
      records: [
        userRecord({ sessionId, content: "/model" }),
        { type: "custom-title", customTitle: "My research session", sessionId },
      ],
    });

    const imported = await importSession(sessionId);

    expect(imported.config.title).toBe("My research session");
  });

  test("keeps the rename when a later record carries no usable name", async () => {
    const sessionId = "malformed-later-record";
    await writeSession({
      sessionId,
      records: [
        userRecord({ sessionId, content: "Review this project" }),
        { type: "custom-title", customTitle: "My research session", sessionId },
        { type: "custom-title", sessionId },
      ],
    });

    const imported = await importSession(sessionId);

    expect(imported.config.title).toBe("My research session");
  });

  test("ignores a rename recorded on a sidechain transcript", async () => {
    const sessionId = "sidechain-rename";
    await writeSession({
      sessionId,
      records: [
        userRecord({ sessionId, content: "Review this project" }),
        { type: "custom-title", customTitle: "Subagent title", sessionId, isSidechain: true },
      ],
    });

    const imported = await importSession(sessionId);

    expect(imported.config.title).toBeUndefined();
  });

  test("leaves the agent untitled when the session was never renamed", async () => {
    const sessionId = "never-renamed";
    await writeSession({
      sessionId,
      records: [userRecord({ sessionId, content: "Review this project" })],
    });

    const imported = await importSession(sessionId);

    expect(imported.config.title).toBeUndefined();
  });

  test("does not name the imported agent after a generated ai-title", async () => {
    const sessionId = "auto-titled";
    await writeSession({
      sessionId,
      records: [
        userRecord({ sessionId, content: "Add pagination to the invoice list" }),
        { type: "ai-title", aiTitle: "Invoice list pagination", sessionId },
      ],
    });

    const imported = await importSession(sessionId);

    // The Import Session list shows it, but agents are named from their first
    // prompt line.
    expect(imported.config.title).toBeUndefined();
  });

  test("imports a session that has no transcript on disk", async () => {
    const imported = await importSession("no-such-session");

    expect(imported.config.title).toBeUndefined();
  });

  test("surfaces an unreadable transcript instead of importing it as never renamed", async () => {
    const sessionId = "unreadable-transcript";
    // A directory where the transcript belongs fails the read with EISDIR, the
    // deterministic stand-in for a permissions or I/O fault.
    const projectDir = claudeProjectDirSync(SESSION_CWD, { configDir });
    await fs.mkdir(path.join(projectDir, `${sessionId}.jsonl`), { recursive: true });

    await expect(importSession(sessionId)).rejects.toThrow();
  });
});

describe("importing a Claude session's permission mode", () => {
  test("keeps the mode of the last user turn", async () => {
    const sessionId = "mode-changed";
    await writeSession({
      sessionId,
      records: [
        userRecord({ sessionId, content: "Plan the schema change", permissionMode: "plan" }),
        userRecord({ sessionId, content: "Go ahead", permissionMode: "auto" }),
      ],
    });

    const imported = await importSession(sessionId);

    expect(imported.config.modeId).toBe("auto");
  });

  test("keeps Always ask when the session last ran in it", async () => {
    const sessionId = "mode-default";
    await writeSession({
      sessionId,
      records: [
        userRecord({ sessionId, content: "Review this project", permissionMode: "auto" }),
        userRecord({ sessionId, content: "Carefully now", permissionMode: "default" }),
      ],
    });

    const imported = await importSession(sessionId);

    expect(imported.config.modeId).toBe("default");
  });

  test("ignores a mode recorded on a sidechain turn", async () => {
    const sessionId = "mode-sidechain";
    await writeSession({
      sessionId,
      records: [
        userRecord({ sessionId, content: "Review this project", permissionMode: "plan" }),
        userRecord({
          sessionId,
          content: "Subagent task",
          permissionMode: "bypassPermissions",
          isSidechain: true,
        }),
      ],
    });

    const imported = await importSession(sessionId);

    expect(imported.config.modeId).toBe("plan");
  });

  test("uses the new-agent default when no mode was recorded", async () => {
    const sessionId = "mode-unrecorded";
    await writeSession({
      sessionId,
      records: [userRecord({ sessionId, content: "Review this project" })],
    });

    const imported = await importSession(sessionId);

    expect(imported.config.modeId).toBe("auto");
  });

  test("falls back to Always ask when the recorded auto mode cannot run on Bedrock", async () => {
    const sessionId = "mode-auto-bedrock";
    await writeSession({
      sessionId,
      records: [userRecord({ sessionId, content: "Review this project", permissionMode: "auto" })],
    });
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveBinary: async () => "/test/claude/bin",
    });

    const imported = await client.importSession(
      { providerHandleId: sessionId, cwd: SESSION_CWD },
      {
        config: { provider: "claude", cwd: SESSION_CWD },
        storedConfig: { provider: "claude", cwd: SESSION_CWD },
        launchContext: { env: { CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CONFIG_DIR: configDir } },
      },
    );

    expect(imported.config.modeId).toBe("default");
  });
});
