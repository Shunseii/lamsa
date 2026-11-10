import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from "electron";
import { findProjectRoot } from "@lamsa/core";
import type { NodeChange, OpenRequest, RecentProject, WelcomeState } from "../shared/api.js";
import { ProjectService } from "./project-service.js";
import { openExternalTerminal, TerminalSession } from "./terminal.js";

const here = fileURLToPath(new URL(".", import.meta.url));

protocol.registerSchemesAsPrivileged([
  { scheme: "lamsa-asset", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

export function parseArgs(argv: string[]): OpenRequest {
  const request: OpenRequest = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (flag !== "--root" && flag !== "--file" && flag !== "--select") continue;
    const value = inline ?? argv[i + 1];
    if (inline === undefined) i++;
    if (!value || value.startsWith("--")) continue;
    if (flag === "--root") request.root = resolve(value);
    else if (flag === "--file") request.file = value;
    else request.select = value;
  }
  if (!request.root && process.env.LAMSA_ROOT) request.root = resolve(process.env.LAMSA_ROOT);
  return request;
}

let window: BrowserWindow | undefined;
let pendingRequest: OpenRequest = parseArgs(process.argv);
let uninitialised: string | undefined;

const send = (channel: string, value: unknown) => window?.webContents.send(channel, value);

const service = new ProjectService({
  external: (change) => send("external-change", change),
  reloaded: (snapshot) => send("project-reloaded", snapshot),
});

const terminal = new TerminalSession({
  data: (data) => send("terminal-data", data),
  exit: (code) => send("terminal-exit", code),
});

const recentFile = () => join(app.getPath("userData"), "recent.json");

async function readRecent(): Promise<RecentProject[]> {
  try {
    return JSON.parse(await readFile(recentFile(), "utf8")) as RecentProject[];
  } catch {
    return [];
  }
}

async function rememberProject(root: string) {
  const recent = (await readRecent()).filter((entry) => entry.root !== root);
  recent.unshift({ root, name: basename(root), openedAt: new Date().toISOString() });
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(recentFile(), JSON.stringify(recent.slice(0, 10), null, 2));
}

function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#ECEAE5",
    title: "lamsa",
    show: !process.env.LAMSA_HIDDEN,
    webPreferences: {
      preload: join(here, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
      offscreen: Boolean(process.env.LAMSA_HIDDEN),
    },
  });
  window.setMenuBarVisibility(false);
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(here, "../renderer/index.html"));
  window.on("closed", () => {
    window = undefined;
  });
}

function registerIpc() {
  ipcMain.handle("welcome", async (): Promise<WelcomeState> => ({ recent: await readRecent(), uninitialised }));

  ipcMain.handle("choose-folder", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    const folder = result.filePaths[0];
    if (result.canceled || !folder) return {};
    const root = findProjectRoot(folder);
    if (!root) {
      uninitialised = folder;
      return { uninitialised: folder };
    }
    return { root };
  });

  ipcMain.handle("open-project", async (_event, requested: string) => {
    const root = findProjectRoot(requested);
    if (!root) throw new Error(`no lamsa.config.json in ${requested}`);
    const snapshot = await service.open(root);
    uninitialised = undefined;
    await rememberProject(root);
    window?.setTitle(`${snapshot.name} · lamsa`);
    return snapshot;
  });

  ipcMain.handle("current", async () => {
    const request = pendingRequest;
    pendingRequest = {};
    const root = request.root ? findProjectRoot(request.root) : undefined;
    if (request.root && !root) uninitialised = request.root;
    if (!root) return service.root ? service.snapshot() : null;
    const snapshot = await service.open(root);
    await rememberProject(root);
    window?.setTitle(`${snapshot.name} · lamsa`);
    if (request.file || request.select) setTimeout(() => send("open-request", { file: request.file, select: request.select }), 50);
    return snapshot;
  });

  ipcMain.handle("apply-changes", (_event, changes: NodeChange[]) => service.applyChanges(changes));
  ipcMain.handle("icons", (_event, names: string[]) => service.icons(names));
  ipcMain.handle("set-selection", (_event, selection: string[], file?: string) => service.setSelection(selection, file));

  ipcMain.handle("render", async (_event, ids: string[], mode?: "light" | "dark") => {
    const root = service.root;
    if (!root) return [];
    const { openWorkspace, renderFrames } = await import("lamsa");
    const workspace = await openWorkspace(root);
    const frames = await renderFrames({
      workspace,
      ids,
      outDir: join(root, ".lamsa", "render"),
      mode,
      naming: (id) => `${id}${mode ? `.${mode}` : ""}.png`,
    });
    return frames.map((f) => ({ id: f.id, path: f.path, width: f.width, height: f.height }));
  });

  ipcMain.handle("import-image", async () => {
    const root = service.root;
    const assets = service.assetsDir;
    if (!root || !assets) return null;
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"] }],
    });
    const picked = result.filePaths[0];
    if (result.canceled || !picked) return null;
    const inside = relative(root, picked);
    if (!inside.startsWith("..")) return { src: inside.split("\\").join("/") };
    await mkdir(assets, { recursive: true });
    const target = join(assets, `${basename(picked, extname(picked))}-${Date.now().toString(36)}${extname(picked)}`);
    await copyFile(picked, target);
    return { src: relative(root, target).split("\\").join("/") };
  });

  ipcMain.handle("reveal-path", (_event, path: string) => shell.showItemInFolder(path));

  ipcMain.handle("terminal-start", (_event, cols: number, rows: number) => {
    const snapshot = service.root ? service.snapshot() : undefined;
    if (!snapshot) return { ok: false, error: "no project open", command: "" };
    const { command, args } = snapshot.config.agent;
    return { ...terminal.start({ cwd: snapshot.root, command, args, cols, rows }), command };
  });
  ipcMain.on("terminal-write", (_event, data: string) => terminal.write(data));
  ipcMain.on("terminal-resize", (_event, cols: number, rows: number) => terminal.resize(cols, rows));
  ipcMain.handle("terminal-external", () => {
    const snapshot = service.root ? service.snapshot() : undefined;
    if (!snapshot) return { ok: false, error: "no project open" };
    return openExternalTerminal({ cwd: snapshot.root, command: snapshot.config.agent.command });
  });
}

const gotLock = process.env.LAMSA_MULTI_INSTANCE ? true : app.requestSingleInstanceLock({ ...pendingRequest });
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv, _cwd, additionalData) => {
    const request = (additionalData as OpenRequest | null) ?? parseArgs(argv);
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
      if (request.root && findProjectRoot(request.root) !== service.root) {
        pendingRequest = request;
        void window.webContents.reload();
      } else {
        send("open-request", request);
      }
    }
  });

  void app.whenReady().then(() => {
    protocol.handle("lamsa-asset", (request) => {
      const url = new URL(request.url);
      const path = service.assetPath(url.pathname.replace(/^\/+/, ""));
      if (!path) return new Response("not found", { status: 404 });
      return net.fetch(pathToFileURL(path).href);
    });
    registerIpc();
    createWindow();
  });

  app.on("window-all-closed", () => {
    terminal.stop();
    void service.close();
    app.quit();
  });
}
