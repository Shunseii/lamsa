/**
 * The agent chat's data model, shared by the main process (which runs the agent CLI and reads past sessions)
 * and the renderer (which draws the chat). Each agent CLI gets its own output parser that turns its
 * structured output into `AgentEvent`s; `applyAgentEvent` folds those into the chat's items.
 *
 * The events follow the shape of the Agent Client Protocol's session updates (message chunks, tool calls and
 * their updates, permission requests, turn end), so another agent's parser (`codex exec --json`) or an ACP
 * client can feed the same chat without UI changes.
 */

/** Whether the chat can run: the agent CLI is installed, signed in, and has structured output lamsa can read. */
export type AgentAvailability =
  | { state: "ready"; command: string }
  | { state: "missing"; command: string }
  | { state: "signed-out"; command: string }
  | { state: "unsupported"; command: string };

/** A layer the user had selected when sending a message; it goes along as context. */
export interface ContextLayer {
  id: string;
  name: string;
  type: string;
  file?: string;
}

export type ChangeKind = "added" | "changed" | "removed";

export interface ChangedLayer {
  id: string;
  name: string;
  type: string;
  kind: ChangeKind;
  /** What changed, e.g. `width 100%`; only for changed layers. */
  detail?: string;
}

export interface ChangedFile {
  file: string;
  layers: ChangedLayer[];
}

/** `blocked`: the user's permission settings refused the call; `rule` is what would allow it. */
export type ToolStatus = "running" | "done" | "error" | "blocked";

export type ChatItem =
  | { kind: "user"; id: string; text: string; context?: ContextLayer[] }
  | { kind: "text"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; input?: Record<string, unknown>; status: ToolStatus; output?: string; rule?: string }
  | { kind: "changes"; id: string; files: ChangedFile[] }
  | { kind: "error"; id: string; message: string }
  | { kind: "stopped"; id: string };

export type StopReason = "end_turn" | "cancelled" | "error";

export type AgentEvent =
  | { type: "session"; sessionId: string }
  /** Something the user said; only past sessions replay these, live turns add the user's message themselves. */
  | { type: "user-message"; id: string; text: string; context?: ContextLayer[] }
  | { type: "message-chunk"; id: string; text: string }
  /** A whole agent message, for agents (or saved sessions) that don't stream. */
  | { type: "message"; id: string; text: string }
  | { type: "tool-call"; id: string; name: string; input?: Record<string, unknown> }
  | { type: "tool-call-update"; id: string; status: "completed" | "failed"; output: string }
  /** A tool call the user's permission settings refused; `rule` is the permission that would allow it. */
  | { type: "permission-request"; id: string; name: string; input?: Record<string, unknown>; rule: string }
  | { type: "changes"; id: string; files: ChangedFile[] }
  /** The turn failed. `reason: "auth"` means the agent isn't signed in. */
  | { type: "turn-error"; message: string; reason?: "auth" }
  /** Always the turn's last event, once the agent process has exited. */
  | { type: "turn-end"; stopReason: StopReason };

/** A batch of events from one chat turn, sent from the main process to the renderer. */
export interface AgentTurnEvents {
  turnId: string;
  sessionId: string;
  events: AgentEvent[];
  /** Changes that arrived just after the turn ended; they update its changes card but don't restart it. */
  trailing?: boolean;
}

/** Sent when the session is opened in, or comes back from, the user's own terminal. */
export interface AgentTerminalState {
  sessionId: string | null;
  open: boolean;
}

export interface AgentSendRequest {
  sessionId: string;
  /** False for the session's first turn: the agent starts a session with this id instead of resuming it. */
  resume: boolean;
  prompt: string;
  context: ContextLayer[];
  /** How many user messages the session had before this one; ties this turn's changes to its message in history. */
  promptIndex: number;
  /** Permissions the user granted in this chat ("Allow & retry"), on top of lamsa's defaults and their own settings. */
  allow: string[];
}

/** A past conversation in this project, read from the agent's own session storage. */
export interface AgentSessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  /** Layers lamsa saw the agent change in this conversation; undefined when it never ran in lamsa's chat. */
  layersChanged?: number;
}

/** Turns one agent CLI's structured output, a line at a time, into chat events. */
export interface AgentStreamParser {
  push(line: string): AgentEvent[];
}

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const AUTH_ERROR = /\b(not logged in|log ?in|invalid api key|authentication|unauthori[sz]ed|oauth token)\b/i;

/** Text from a tool result's content, which is a string or a list of content blocks. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (isRecord(block) && block.type === "text" ? (asString(block.text) ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

/** The text a person typed, from a user record; empty for tool results and the CLI's own injected messages. */
function promptText(content: unknown): string {
  const text = typeof content === "string" ? content : Array.isArray(content) ? contentText(content) : "";
  const trimmed = text.trim();
  // Slash commands, command output, and system reminders are wrapped in tags; they aren't the user's words.
  if (!trimmed || trimmed.startsWith("<") || trimmed.startsWith("Caveat:")) return "";
  return trimmed;
}

const INTERRUPTED = /^\[Request interrupted by user/;

/** The Claude Code permission rule that allows one refused tool call: the exact command for Bash, else the tool. */
export function claudePermissionRule({ name, input }: { name: string; input?: Record<string, unknown> }): string {
  const command = asString(input?.command)?.trim();
  if (name === "Bash" && command) return `Bash(${command})`;
  return name;
}

/**
 * Claude Code's `--output-format stream-json` (with `--verbose` and `--include-partial-messages`). Session
 * transcripts on disk use the same `user` and `assistant` records, so the same parser reads past conversations.
 */
export function createClaudeStreamParser(): AgentStreamParser {
  let messageId = "";
  const streamed = new Set<string>();

  function assistant(record: JsonRecord): AgentEvent[] {
    const message = isRecord(record.message) ? record.message : undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    const id = asString(message?.id) ?? asString(record.uuid) ?? "";
    const key = asString(record.uuid) ?? id;
    const events: AgentEvent[] = [];
    content.forEach((block, position) => {
      if (!isRecord(block)) return;
      if (block.type === "text" && !streamed.has(id)) {
        const text = asString(block.text) ?? "";
        if (text.trim()) events.push({ type: "message", id: `${key}:${position}`, text });
      } else if (block.type === "tool_use") {
        events.push({
          type: "tool-call",
          id: asString(block.id) ?? `${key}:${position}`,
          name: asString(block.name) ?? "tool",
          input: isRecord(block.input) ? block.input : undefined,
        });
      }
    });
    return events;
  }

  function user(record: JsonRecord): AgentEvent[] {
    const message = isRecord(record.message) ? record.message : undefined;
    const content = message?.content;
    if (Array.isArray(content) && content.some((block) => isRecord(block) && block.type === "tool_result")) {
      return content.flatMap((block): AgentEvent[] =>
        isRecord(block) && block.type === "tool_result"
          ? [{ type: "tool-call-update", id: asString(block.tool_use_id) ?? "", status: block.is_error === true ? "failed" : "completed", output: contentText(block.content) }]
          : [],
      );
    }
    const raw = typeof content === "string" ? content : contentText(content);
    if (INTERRUPTED.test(raw.trim())) return [{ type: "turn-end", stopReason: "cancelled" }];
    if (record.isMeta === true) return [];
    const text = promptText(content);
    const id = asString(record.uuid) ?? `user-${Math.random().toString(36).slice(2)}`;
    return text ? [{ type: "user-message", id, text }] : [];
  }

  function streamEvent(record: JsonRecord): AgentEvent[] {
    const event = isRecord(record.event) ? record.event : undefined;
    if (!event) return [];
    if (event.type === "message_start" && isRecord(event.message)) {
      messageId = asString(event.message.id) ?? messageId;
      return [];
    }
    const index = typeof event.index === "number" ? event.index : 0;
    if (event.type === "content_block_start" && isRecord(event.content_block) && event.content_block.type === "tool_use") {
      const block = event.content_block;
      return [{ type: "tool-call", id: asString(block.id) ?? `${messageId}:${index}`, name: asString(block.name) ?? "tool" }];
    }
    if (event.type === "content_block_delta" && isRecord(event.delta) && event.delta.type === "text_delta") {
      const text = asString(event.delta.text) ?? "";
      if (!text) return [];
      streamed.add(messageId);
      return [{ type: "message-chunk", id: `${messageId}:s${index}`, text }];
    }
    return [];
  }

  function result(record: JsonRecord): AgentEvent[] {
    const denials = Array.isArray(record.permission_denials) ? record.permission_denials.filter(isRecord) : [];
    const events: AgentEvent[] = denials.map((denial) => {
      const name = asString(denial.tool_name) ?? "tool";
      const input = isRecord(denial.tool_input) ? denial.tool_input : undefined;
      return { type: "permission-request", id: asString(denial.tool_use_id) ?? "", name, input, rule: claudePermissionRule({ name, input }) };
    });
    const ok = record.is_error !== true && (record.subtype === undefined || record.subtype === "success");
    if (ok) return events;
    const errors = Array.isArray(record.errors) ? record.errors.filter((e): e is string => typeof e === "string") : [];
    const message = asString(record.result)?.trim() || errors.join("\n") || String(record.subtype ?? "The agent failed").replaceAll("_", " ");
    return [...events, { type: "turn-error", message, ...(AUTH_ERROR.test(message) ? { reason: "auth" as const } : {}) }];
  }

  return {
    push(line) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return [];
      let record: unknown;
      try {
        record = JSON.parse(trimmed);
      } catch {
        return [];
      }
      if (!isRecord(record)) return [];
      // Subagents' own messages: the chat shows the step that started them, not their inner workings.
      if (record.isSidechain === true || (record.parent_tool_use_id !== undefined && record.parent_tool_use_id !== null)) return [];
      switch (record.type) {
        case "system":
          return record.subtype === "init" && typeof record.session_id === "string" ? [{ type: "session", sessionId: record.session_id }] : [];
        case "stream_event":
          return streamEvent(record);
        case "assistant":
          return assistant(record);
        case "user":
          return user(record);
        case "result":
          return result(record);
        default:
          return [];
      }
    },
  };
}

const MAX_TOOL_OUTPUT = 4000;

function lastIndexOfId(items: ChatItem[], id: string): number {
  for (let i = items.length - 1; i >= 0; i--) if (items[i]!.id === id) return i;
  return -1;
}

function replaceAt(items: ChatItem[], index: number, item: ChatItem): ChatItem[] {
  const next = items.slice();
  next[index] = item;
  return next;
}

/** Marks steps still running as finished (or failed) when the turn ends. */
function settleTools(items: ChatItem[], status: ToolStatus): ChatItem[] {
  if (!items.some((item) => item.kind === "tool" && item.status === "running")) return items;
  return items.map((item) => (item.kind === "tool" && item.status === "running" ? { ...item, status } : item));
}

let noteCount = 0;

/** Folds one event into the chat. Returns the same array when nothing changed, so React can skip work. */
export function applyAgentEvent(items: ChatItem[], event: AgentEvent): ChatItem[] {
  switch (event.type) {
    case "user-message": {
      if (lastIndexOfId(items, event.id) >= 0) return items;
      return [...items, { kind: "user", id: event.id, text: event.text, ...(event.context?.length ? { context: event.context } : {}) }];
    }
    case "message-chunk": {
      const index = lastIndexOfId(items, event.id);
      if (index < 0) return [...items, { kind: "text", id: event.id, text: event.text }];
      const item = items[index]!;
      return item.kind === "text" ? replaceAt(items, index, { ...item, text: item.text + event.text }) : items;
    }
    case "message": {
      const index = lastIndexOfId(items, event.id);
      if (index < 0) return [...items, { kind: "text", id: event.id, text: event.text }];
      return replaceAt(items, index, { kind: "text", id: event.id, text: event.text });
    }
    case "tool-call": {
      const index = lastIndexOfId(items, event.id);
      if (index < 0) return [...items, { kind: "tool", id: event.id, name: event.name, input: event.input, status: "running" }];
      const item = items[index]!;
      if (item.kind !== "tool") return items;
      return replaceAt(items, index, { ...item, name: event.name, input: event.input ?? item.input });
    }
    case "tool-call-update": {
      const index = lastIndexOfId(items, event.id);
      const item = index >= 0 ? items[index] : undefined;
      if (!item || item.kind !== "tool") return items;
      const output = event.output.length > MAX_TOOL_OUTPUT ? `${event.output.slice(0, MAX_TOOL_OUTPUT)}…` : event.output;
      // A refusal reported before the call's own failure keeps its "blocked" state.
      const status = item.status === "blocked" ? "blocked" : event.status === "completed" ? "done" : "error";
      return replaceAt(items, index, { ...item, status, output });
    }
    case "permission-request": {
      const index = lastIndexOfId(items, event.id);
      const item = index >= 0 ? items[index] : undefined;
      if (item?.kind === "tool") return replaceAt(items, index, { ...item, status: "blocked", rule: event.rule });
      return [...items, { kind: "tool", id: event.id || `blocked-${++noteCount}`, name: event.name, input: event.input, status: "blocked", rule: event.rule }];
    }
    case "changes": {
      const index = lastIndexOfId(items, event.id);
      const item: ChatItem = { kind: "changes", id: event.id, files: event.files };
      if (index < 0) return event.files.length ? [...items, item] : items;
      return event.files.length ? replaceAt(items, index, item) : items.filter((_, i) => i !== index);
    }
    case "turn-error":
      return [...settleTools(items, "error"), { kind: "error", id: `error-${++noteCount}`, message: event.message }];
    case "turn-end":
      if (event.stopReason === "cancelled") return [...settleTools(items, "error"), { kind: "stopped", id: `stopped-${++noteCount}` }];
      return settleTools(items, event.stopReason === "error" ? "error" : "done");
    default:
      return items;
  }
}

export const applyAgentEvents = (items: ChatItem[], events: AgentEvent[]) => events.reduce(applyAgentEvent, items);

/** Session ids are UUIDs; anything else is refused before it reaches a file path or a command line. */
export const isSessionId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
