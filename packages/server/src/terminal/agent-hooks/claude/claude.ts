import { endsWithQuestionToUser } from "../../../server/agent/awaiting-input.js";
import { readLastAssistantText } from "./claude-transcript.js";
import type { AgentHookActivityState, AgentHookProvider } from "../agent-hook-installer.js";
import { type ClaudeSettings, claudeSettingsFormat } from "./claude-settings.js";

const CLAUDE_EVENT_STATES: Record<string, AgentHookActivityState> = {
  UserPromptSubmit: "running",
  StopFailure: "idle",
  SessionEnd: "idle",
};

export const claudeAgentHookProvider: AgentHookProvider<ClaudeSettings> = {
  id: "claude",
  events: [
    { event: "UserPromptSubmit" },
    { event: "Stop" },
    { event: "StopFailure" },
    { event: "SessionEnd" },
    { event: "Notification" },
  ],
  install: {
    kind: "config-file",
    configDir: ".claude",
    configFile: "settings.json",
    configDirEnvOverride: "CLAUDE_CONFIG_DIR",
    hookMarker: "hooks claude",
    format: claudeSettingsFormat,
  },
  async resolveActivity({ event, input }) {
    if (event === "Notification") {
      const payload = parseJsonRecord(input.isTTY ? null : await input.read());
      const type = payload?.notification_type;
      // idle_prompt fires about a minute after every finished turn; it says nothing about
      // whether Claude is waiting on a decision, so it is deliberately ignored.
      return type === "permission_prompt" || type === "elicitation_dialog" ? "needs-input" : null;
    }

    if (event === "Stop") {
      return resolveStopActivity(input.isTTY ? null : await input.read());
    }

    return CLAUDE_EVENT_STATES[event] ?? null;
  },
};

async function resolveStopActivity(raw: string | null): Promise<AgentHookActivityState> {
  try {
    const payload = parseJsonRecord(raw);
    if (!payload) return "idle";
    const direct = payload.last_assistant_message;
    let text: string | null = null;
    if (typeof direct === "string") {
      text = direct;
    } else if (typeof payload.transcript_path === "string") {
      text = await readLastAssistantText(payload.transcript_path);
    }
    return endsWithQuestionToUser(text) ? "needs-input" : "idle";
  } catch {
    return "idle";
  }
}

function parseJsonRecord(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
