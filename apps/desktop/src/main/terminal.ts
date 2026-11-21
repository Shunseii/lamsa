import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, isAbsolute, join } from "node:path";

export function findCommand(command: string): string | undefined {
  if (isAbsolute(command)) return existsSync(command) ? command : undefined;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

type TerminalArgs = (cwd: string, run: string[]) => string[];

const EXTERNAL_TERMINALS: { command: string; args: TerminalArgs }[] = [
  { command: "x-terminal-emulator", args: (cwd, run) => ["--working-directory", cwd, "-e", ...run] },
  { command: "gnome-terminal", args: (cwd, run) => ["--working-directory", cwd, "--", ...run] },
  { command: "cosmic-term", args: (cwd, run) => ["--working-directory", cwd, "-e", ...run] },
  { command: "kitty", args: (cwd, run) => ["--directory", cwd, ...run] },
  { command: "wezterm", args: (cwd, run) => ["start", "--cwd", cwd, "--", ...run] },
  { command: "alacritty", args: (cwd, run) => ["--working-directory", cwd, "-e", ...run] },
  { command: "konsole", args: (cwd, run) => ["--workdir", cwd, "-e", ...run] },
  { command: "foot", args: (cwd, run) => ["--working-directory", cwd, ...run] },
  { command: "ghostty", args: (cwd, run) => [`--working-directory=${cwd}`, "-e", ...run] },
];

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** How often lamsa checks whether the command it opened in a terminal is still running. */
const WATCH_MS = 1000;
/** Some terminals take a while to start; if the command never starts, the terminal is assumed closed. */
const START_TIMEOUT_MS = 30_000;

/** The user's terminal: $TERMINAL first, then the first known one on PATH. */
function pickTerminal(): { command: string; args: TerminalArgs } | undefined {
  const preferred = process.env.TERMINAL?.trim();
  if (preferred && findCommand(preferred)) {
    const known = EXTERNAL_TERMINALS.find((terminal) => terminal.command === basename(preferred));
    return { command: preferred, args: known?.args ?? ((_cwd, run) => ["-e", ...run]) };
  }
  // Hidden runs (tests) only ever use an explicit $TERMINAL, so they never open a window on the desktop.
  if (process.env.LAMSA_HIDDEN) return undefined;
  return EXTERNAL_TERMINALS.find((terminal) => findCommand(terminal.command));
}

/**
 * Opens the user's own terminal in `cwd` running `command`. The command records its process id first, so
 * `onExit` fires when it ends, even for terminals that hand the window to a server process and exit at once.
 */
export function openExternalTerminal({
  cwd,
  command,
  args = [],
  onExit,
}: {
  cwd: string;
  command: string;
  args?: string[];
  onExit?: () => void;
}): { ok: boolean; error?: string } {
  const folder = mkdtempSync(join(tmpdir(), "lamsa-terminal-"));
  const pidFile = join(folder, "pid");
  const script = `printf %s "$$" > ${quote(pidFile)}; exec ${[command, ...args].map(quote).join(" ")}`;
  const run = ["sh", "-c", script];

  if (process.platform === "darwin" && !process.env.LAMSA_HIDDEN) {
    const shellLine = `cd ${quote(cwd)} && sh -c ${quote(script)}`;
    const appleScript = `tell application "Terminal"\nactivate\ndo script ${JSON.stringify(shellLine)}\nend tell`;
    spawn("osascript", ["-e", appleScript], { detached: true, stdio: "ignore" }).unref();
  } else {
    const terminal = pickTerminal();
    if (!terminal) {
      rmSync(folder, { recursive: true, force: true });
      return { ok: false, error: "no terminal emulator found; set $TERMINAL to yours" };
    }
    spawn(terminal.command, terminal.args(cwd, run), { cwd, detached: true, stdio: "ignore" }).unref();
  }

  const startedAt = Date.now();
  let pid: number | undefined;
  const timer = setInterval(() => {
    if (pid === undefined) {
      try {
        pid = Number(readFileSync(pidFile, "utf8")) || undefined;
      } catch {
        // Not started yet.
      }
      if (pid === undefined && Date.now() - startedAt < START_TIMEOUT_MS) return;
    }
    if (pid !== undefined && isAlive(pid)) return;
    clearInterval(timer);
    rmSync(folder, { recursive: true, force: true });
    onExit?.();
  }, WATCH_MS);
  return { ok: true };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
