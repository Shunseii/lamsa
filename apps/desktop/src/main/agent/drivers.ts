import { basename } from "node:path";
import { type AgentStreamParser, createClaudeStreamParser } from "../../shared/agent.js";

/** How lamsa drives one agent CLI: its headless chat command, its interactive command, and its output parser. */
export interface AgentDriver {
  /** Arguments for one headless chat turn; the prompt goes to stdin. */
  chatArgs(options: { sessionId: string; resume: boolean; systemPrompt: string; allow: string[] }): string[];
  /** Arguments for the interactive session in the user's own terminal. */
  terminalArgs(options: { sessionId: string; resume: boolean }): string[];
  createParser(): AgentStreamParser;
}

export const DEFAULT_ALLOWED_TOOLS = ["Bash(lamsa *)", "Read", "Edit", "Write"];

const claude: AgentDriver = {
  chatArgs: ({ sessionId, resume, systemPrompt, allow }) => [
    "-p",
    resume ? "--resume" : "--session-id",
    sessionId,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    // On top of the user's own Claude settings: the lamsa CLI and file tools in the project. Anything else is
    // refused and shows as a blocked step the user can allow for this chat.
    "--allowedTools",
    ...DEFAULT_ALLOWED_TOOLS,
    ...allow,
    "--append-system-prompt",
    systemPrompt,
  ],
  terminalArgs: ({ sessionId, resume }) => [resume ? "--resume" : "--session-id", sessionId],
  createParser: createClaudeStreamParser,
};

const DRIVERS: Record<string, AgentDriver> = { claude };

/** The driver for an agent command, or undefined when lamsa can't read its output (it runs in a terminal instead). */
export function driverFor(command: string): AgentDriver | undefined {
  const name = basename(command).replace(/\.(exe|cmd)$/i, "");
  return DRIVERS[name];
}
