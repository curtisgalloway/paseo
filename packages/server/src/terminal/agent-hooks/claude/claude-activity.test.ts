import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeAgentHookProvider } from "./claude.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function transcript(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "paseo-claude-transcript-"));
  dirs.push(dir);
  const path = join(dir, "session.jsonl");
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

function assistant(text: string, id = "msg-1") {
  return { type: "assistant", message: { id, content: [{ type: "text", text }] } };
}

const user = { type: "user", message: { content: "do the thing" } };

function resolve(event: string, payload: unknown) {
  return claudeAgentHookProvider.resolveActivity({
    event,
    input: { read: async () => (payload === null ? null : JSON.stringify(payload)) },
  });
}

describe("Claude hook activity", () => {
  it("reports needs-input when Stop ends on a question to the user", async () => {
    const path = transcript([user, assistant("Done. Should I also update the docs?")]);
    expect(await resolve("Stop", { transcript_path: path })).toBe("needs-input");
  });

  it("reports idle when Stop does not end on a question", async () => {
    const path = transcript([user, assistant("All done.")]);
    expect(await resolve("Stop", { transcript_path: path })).toBe("idle");
  });

  it("judges only the last assistant message, joining its split lines", async () => {
    const path = transcript([
      assistant("Which file?", "msg-0"),
      user,
      assistant("Working on it.", "msg-1"),
      { type: "assistant", message: { id: "msg-1", content: [{ type: "tool_use", id: "t" }] } },
      assistant("Finished the change.", "msg-1"),
    ]);
    expect(await resolve("Stop", { transcript_path: path })).toBe("idle");
  });

  it("uses last_assistant_message when the input has one", async () => {
    expect(await resolve("Stop", { last_assistant_message: "Want me to continue?" })).toBe(
      "needs-input",
    );
  });

  it("fails open to idle when the transcript is unreadable or the input is not JSON", async () => {
    expect(await resolve("Stop", { transcript_path: "/nonexistent/none.jsonl" })).toBe("idle");
    expect(await resolve("Stop", null)).toBe("idle");
    const garbage = await claudeAgentHookProvider.resolveActivity({
      event: "Stop",
      input: { read: async () => "not json" },
    });
    expect(garbage).toBe("idle");
  });

  it("reads only the tail of a large transcript", async () => {
    const filler = assistant("x".repeat(1000), "msg-filler");
    const lines = Array.from({ length: 600 }, () => filler);
    const path = transcript([...lines, user, assistant("Ready to merge?")]);
    expect(await resolve("Stop", { transcript_path: path })).toBe("needs-input");
  });

  it("ignores idle_prompt and reports blocking notifications", async () => {
    expect(await resolve("Notification", { notification_type: "idle_prompt" })).toBeNull();
    expect(await resolve("Notification", { notification_type: "permission_prompt" })).toBe(
      "needs-input",
    );
    expect(await resolve("Notification", { notification_type: "elicitation_dialog" })).toBe(
      "needs-input",
    );
    expect(await resolve("Notification", { notification_type: "auth_success" })).toBeNull();
  });

  it("keeps the other event mappings", async () => {
    expect(await resolve("UserPromptSubmit", null)).toBe("running");
    expect(await resolve("StopFailure", null)).toBe("idle");
    expect(await resolve("SessionEnd", null)).toBe("idle");
  });
});
