/** "Now", "5m ago", "2h ago", "Yesterday", "3 days ago", then the date. */
export function relativeTime(time: number, now = Date.now()): string {
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return "Now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const days = Math.ceil((startOfToday - time) / 86_400_000);
  if (days <= 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  const date = new Date(time);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** A path relative to the project root when it's inside it. */
export function projectPath(path: string, root: string): string {
  if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return path;
}

const str = (value: unknown) => (typeof value === "string" ? value : "");

/** How a tool call reads in the chat: a verb and what it acted on, e.g. `Edit designs/checkout.lamsa.json`. */
export function describeTool({ name, input, root }: { name: string; input: Record<string, unknown> | undefined; root: string }): {
  verb: string;
  detail: string;
} {
  const args = input ?? {};
  switch (name) {
    case "Bash": {
      const command = str(args.command).trim();
      const verb = /^lamsa (validate|fmt)\b/.test(command)
        ? "Validate"
        : /^lamsa (tree|tokens|components|selection|schema|skill|diff)\b/.test(command)
          ? "Read"
          : /^lamsa render\b/.test(command)
            ? "Render"
            : "Run";
      return { verb, detail: command.split("\n")[0] ?? "" };
    }
    case "Read":
      return { verb: "Read", detail: projectPath(str(args.file_path), root) };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { verb: "Edit", detail: projectPath(str(args.file_path) || str(args.notebook_path), root) };
    case "Write":
      return { verb: "Write", detail: projectPath(str(args.file_path), root) };
    case "Grep":
    case "Glob":
      return { verb: "Search", detail: str(args.pattern) };
    case "WebFetch":
      return { verb: "Fetch", detail: str(args.url) };
    case "WebSearch":
      return { verb: "Search the web", detail: str(args.query) };
    case "TodoWrite":
      return { verb: "Plan", detail: "" };
    case "Task":
    case "Agent":
      return { verb: "Delegate", detail: str(args.description) };
    case "Skill":
      return { verb: "Use skill", detail: str(args.skill) };
    default:
      return { verb: name.replace(/^mcp__[^_]+__/, ""), detail: "" };
  }
}
