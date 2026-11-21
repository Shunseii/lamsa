import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { IpcMain, WebContents } from "electron";
import {
  type AgentAvailability,
  type AgentSendRequest,
  type AgentTerminalState,
  isSessionId,
} from "../../shared/agent.js";
import type { ExternalChange } from "../../shared/api.js";
import type { ProjectService } from "../project-service.js";
import { findCommand, openExternalTerminal } from "../terminal.js";
import { driverFor } from "./drivers.js";
import { AgentRunner } from "./runner.js";
import { defaultProjectsDir, listSessions, loadTranscript, recordTurnChanges } from "./sessions.js";

const STATUS_TIMEOUT_MS = 8000;

interface AuthStatus {
  loggedIn?: boolean;
  projectsDirectory?: string;
}

/** `claude auth status` says whether the user is signed in and where sessions live, without a network call. */
function authStatus(command: string): Promise<AuthStatus | undefined> {
  return new Promise((resolve) => {
    execFile(command, ["auth", "status", "--json"], { timeout: STATUS_TIMEOUT_MS, env: process.env }, (_error, stdout) => {
      try {
        resolve(JSON.parse(stdout) as AuthStatus);
      } catch {
        resolve(undefined);
      }
    });
  });
}

export type WindowAgent = ReturnType<typeof createAgent>;

/** One window's agent chat: its runner, the session list, and the sessions handed to the user's terminal. */
export function createAgent({ service, send }: { service: ProjectService; send: (channel: string, value: unknown) => void }) {
  let projectsDir = defaultProjectsDir();
  /** Sessions open in the user's terminal; the chat leaves them alone until the terminal closes. */
  const external = new Set<string>();

  const runner = new AgentRunner({
    emit: (batch) => send("agent-events", batch),
    finished: ({ sessionId, promptIndex, changes }) => {
      const root = service.root;
      if (root) void recordTurnChanges({ root, sessionId, prompt: promptIndex, changes });
    },
    current: () => service.nodesByFile(),
  });

  const agentConfig = () => {
    const { root, config } = service;
    return root && config ? { root, ...config.agent } : undefined;
  };

  return {
    async status(): Promise<AgentAvailability | null> {
      const config = agentConfig();
      if (!config) return null;
      const { command } = config;
      if (!driverFor(command)) return { state: "unsupported", command };
      const resolved = findCommand(command);
      if (!resolved) return { state: "missing", command };
      const status = await authStatus(resolved);
      if (status?.projectsDirectory) projectsDir = status.projectsDirectory;
      if (status?.loggedIn === false) return { state: "signed-out", command };
      return { state: "ready", command };
    },

    send(request: AgentSendRequest) {
      const config = agentConfig();
      const driver = config && driverFor(config.command);
      if (!config || !driver) return { ok: false, error: "chat isn't available for this agent" };
      if (!isSessionId(request.sessionId)) return { ok: false, error: "invalid session id" };
      if (external.has(request.sessionId)) return { ok: false, error: "this chat is open in your terminal" };
      return runner.start({
        driver,
        cwd: config.root,
        command: config.command,
        args: config.args,
        sessionId: request.sessionId,
        resume: request.resume,
        prompt: request.prompt,
        context: request.context,
        promptIndex: request.promptIndex,
        allow: (request.allow ?? []).filter((rule) => typeof rule === "string" && rule.length < 2000),
        baseline: service.nodesByFile(),
      });
    },

    stop: () => runner.stop(),

    sessions() {
      const root = service.root;
      return root ? listSessions({ projectsDir, root }) : [];
    },

    transcript(sessionId: string) {
      const config = agentConfig();
      const driver = config && driverFor(config.command);
      if (!config || !driver || !isSessionId(sessionId)) return null;
      return loadTranscript({ projectsDir, root: config.root, sessionId, parser: driver.createParser() });
    },

    terminal(request: { sessionId: string | null; resume: boolean }) {
      const config = agentConfig();
      if (!config) return { ok: false, error: "no project open" };
      const driver = driverFor(config.command);
      if (!driver) return openExternalTerminal({ cwd: config.root, command: config.command, args: config.args });
      const sessionId = isSessionId(request.sessionId) ? request.sessionId : randomUUID();
      if (external.has(sessionId)) return { ok: true, sessionId };
      // One session, one writer: a turn in progress stops before the terminal takes over.
      runner.stop();
      const resume = isSessionId(request.sessionId) && request.resume;
      const opened = openExternalTerminal({
        cwd: config.root,
        command: config.command,
        args: [...config.args, ...driver.terminalArgs({ sessionId, resume })],
        onExit: () => {
          external.delete(sessionId);
          send("agent-terminal", { sessionId, open: false } satisfies AgentTerminalState);
        },
      });
      if (!opened.ok) return opened;
      external.add(sessionId);
      send("agent-terminal", { sessionId, open: true } satisfies AgentTerminalState);
      return { ok: true, sessionId };
    },

    /** Signs in from the user's terminal: lamsa never sees the credentials. */
    signIn() {
      const config = agentConfig();
      if (!config) return { ok: false, error: "no project open" };
      return openExternalTerminal({ cwd: config.root, command: config.command, args: config.args });
    },

    noteChange: (change: ExternalChange) => runner.noteChange(change),
  };
}

/** The agent chat's IPC: each call goes to the agent of the window that made it. */
export function registerAgentIpc({
  ipcMain,
  agentFor,
}: {
  ipcMain: IpcMain;
  agentFor: (sender: WebContents) => WindowAgent | undefined;
}) {
  const closed = { ok: false, error: "this window is closing" };
  ipcMain.handle("agent-status", (event) => agentFor(event.sender)?.status() ?? null);
  ipcMain.handle("agent-send", (event, request: AgentSendRequest) => agentFor(event.sender)?.send(request) ?? closed);
  ipcMain.handle("agent-stop", (event) => agentFor(event.sender)?.stop());
  ipcMain.handle("agent-sessions", (event) => agentFor(event.sender)?.sessions() ?? []);
  ipcMain.handle("agent-transcript", (event, sessionId: string) => agentFor(event.sender)?.transcript(sessionId) ?? null);
  ipcMain.handle(
    "agent-terminal",
    (event, request: { sessionId: string | null; resume: boolean }) => agentFor(event.sender)?.terminal(request) ?? closed,
  );
  ipcMain.handle("agent-sign-in", (event) => agentFor(event.sender)?.signIn() ?? closed);
}
