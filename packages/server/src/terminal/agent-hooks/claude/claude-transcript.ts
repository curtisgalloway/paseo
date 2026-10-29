import { open } from "node:fs/promises";

const TAIL_BYTES = 256 * 1024;

/**
 * Text of the last assistant message in a Claude transcript (JSONL), reading only the tail
 * of the file. One message can span several lines that share `message.id`; their `text`
 * blocks are concatenated. Returns null when there is none. Throws on read failure; the
 * caller fails open.
 */
export async function readLastAssistantText(path: string): Promise<string | null> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines = lines.slice(1);
    return lastAssistantText(lines);
  } finally {
    await handle.close();
  }
}

interface AssistantEntry {
  id: string | null;
  text: string;
}

function lastAssistantText(lines: string[]): string | null {
  const parts: string[] = [];
  let id: string | null | undefined;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const entry = parseAssistantLine(lines[index]);
    if (entry === "skip") continue;
    if (entry === null) {
      if (id !== undefined) break;
      continue;
    }
    if (id === undefined) id = entry.id;
    else if (entry.id === null || entry.id !== id) break;
    if (entry.text) parts.unshift(entry.text);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

// "skip": blank/unparseable line; null: a non-assistant entry; otherwise the assistant entry.
function parseAssistantLine(line: string): AssistantEntry | null | "skip" {
  if (!line.trim()) return "skip";
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return "skip";
  }
  if (!isRecord(parsed)) return "skip";
  if (parsed.type !== "assistant" || !isRecord(parsed.message)) return null;
  const message = parsed.message;
  const id = typeof message.id === "string" ? message.id : null;
  const content = message.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
      .map((block) => (block as { text: string }).text)
      .join("\n");
  }
  return { id, text };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
