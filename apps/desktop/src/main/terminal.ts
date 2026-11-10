import { spawn as spawnProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { spawn, type IPty } from "node-pty";

export function findCommand(command: string): string | undefined {
  if (isAbsolute(command)) return existsSync(command) ? command : undefined;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export class TerminalSession {
  private pty?: IPty;

  constructor(
    private readonly events: { data: (data: string) => void; exit: (code: number) => void },
  ) {}

  start({
    cwd,
    command,
    args,
    cols,
    rows,
  }: {
    cwd: string;
    command: string;
    args: string[];
    cols: number;
    rows: number;
  }): { ok: boolean; error?: string } {
    this.stop();
    const resolved = findCommand(command);
    if (!resolved) {
      return { ok: false, error: `agent command not found: ${command}` };
    }
    this.pty = spawn(resolved, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>,
    });
    this.pty.onData((data) => this.events.data(data));
    this.pty.onExit(({ exitCode }) => {
      this.pty = undefined;
      this.events.exit(exitCode);
    });
    return { ok: true };
  }

  write(data: string) {
    this.pty?.write(data);
  }

  resize(cols: number, rows: number) {
    if (cols > 0 && rows > 0) this.pty?.resize(cols, rows);
  }

  stop() {
    this.pty?.kill();
    this.pty = undefined;
  }
}

const EXTERNAL_TERMINALS: { command: string; args: (cwd: string, run: string) => string[] }[] = [
  { command: "x-terminal-emulator", args: (cwd, run) => ["--working-directory", cwd, "-e", run] },
  { command: "gnome-terminal", args: (cwd, run) => ["--working-directory", cwd, "--", run] },
  { command: "cosmic-term", args: (cwd, run) => ["--working-directory", cwd, "-e", run] },
  { command: "kitty", args: (cwd, run) => ["--directory", cwd, run] },
  { command: "wezterm", args: (cwd, run) => ["start", "--cwd", cwd, run] },
  { command: "alacritty", args: (cwd, run) => ["--working-directory", cwd, "-e", run] },
  { command: "konsole", args: (cwd, run) => ["--workdir", cwd, "-e", run] },
];

export function openExternalTerminal({ cwd, command }: { cwd: string; command: string }): { ok: boolean; error?: string } {
  if (process.platform === "darwin") {
    spawnProcess("open", ["-a", "Terminal", cwd], { detached: true, stdio: "ignore" }).unref();
    return { ok: true };
  }
  for (const terminal of EXTERNAL_TERMINALS) {
    if (!findCommand(terminal.command)) continue;
    spawnProcess(terminal.command, terminal.args(cwd, command), { cwd, detached: true, stdio: "ignore" }).unref();
    return { ok: true };
  }
  return { ok: false, error: "no terminal emulator found" };
}
