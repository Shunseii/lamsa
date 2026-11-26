import { existsSync, mkdtempSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, net, protocol, screen, shell } from "electron";
import { checkFileCss, checkNodeCss, findProjectRoot, formatFileCss, formatNodeCss, lucideIconNames } from "@lamsa/core";
import type { Change, CommentRequest, CssScope, FrameSnapshotRequest, OpenRequest, ProjectSnapshot, RecentProject, WelcomeState } from "../shared/api.js";
import { CommentsService } from "./comments-service.js";
import { ProjectService } from "./project-service.js";
import { createAgent, registerAgentIpc, type WindowAgent } from "./agent/ipc.js";
import { FrameSnapshots } from "./frame-snapshots.js";
import { startUpdates } from "./updates.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const hidden = Boolean(process.env.LAMSA_HIDDEN);

app.setName("lamsa");
// Tests and other hidden runs keep their own settings, so they never touch the user's recent projects.
if (hidden) app.setPath("userData", mkdtempSync(join(tmpdir(), "lamsa-user-data-")));

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
    else request.select = [...(request.select ?? []), ...value.split(",").map((id) => id.trim()).filter(Boolean)];
  }
  if (!request.root && process.env.LAMSA_ROOT) request.root = resolve(process.env.LAMSA_ROOT);
  return request;
}

/** Everything one window owns: its project, its agent chat, and what it was asked to open. */
interface ProjectWindow {
  window: BrowserWindow;
  /** The host of this window's `lamsa-asset://` URLs, so each window loads images and fonts from its own project. */
  assetHost: string;
  service: ProjectService;
  comments: CommentsService;
  agent: WindowAgent;
  /** Draws the bitmaps the canvas shows for frames when zoomed far out. */
  snapshots: FrameSnapshots;
  send: (channel: string, value: unknown) => void;
  /** Taken by the page when it loads: the project, file, and selection to open. */
  pending: OpenRequest;
  /** The project this window is opening, so a second request for it comes here instead of opening it twice. */
  opening?: string;
  /** Folder the user picked that has no lamsa.config.json yet. */
  uninitialised?: string;
}

/** Open windows by their web contents' id, which is what IPC events carry. */
const windows = new Map<number, ProjectWindow>();
let windowCount = 0;

const projectOf = (context: ProjectWindow) => context.service.root ?? context.opening;
const windowFor = (root: string) => [...windows.values()].find((context) => projectOf(context) === root);
const isEmpty = (context: ProjectWindow) => !projectOf(context) && !context.pending.root;
const rootOf = (request: OpenRequest) => (request.root ? findProjectRoot(request.root) : undefined);

const recentFile = () => join(app.getPath("userData"), "recent.json");
/** Where recent projects lived before the app was named "lamsa" (it used the package name). */
const legacyRecentFile = () => join(app.getPath("appData"), "@lamsa", "desktop", "recent.json");

async function readRecent(): Promise<RecentProject[]> {
  const file = existsSync(recentFile()) || hidden ? recentFile() : legacyRecentFile();
  try {
    const recent = JSON.parse(await readFile(file, "utf8")) as RecentProject[];
    return recent.filter((entry) => existsSync(entry.root));
  } catch {
    return [];
  }
}

async function writeRecent(recent: RecentProject[]) {
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(recentFile(), JSON.stringify(recent.slice(0, 10), null, 2));
}

async function rememberProject(root: string) {
  const recent = (await readRecent()).filter((entry) => entry.root !== root);
  recent.unshift({ root, name: basename(root), openedAt: new Date().toISOString() });
  await writeRecent(recent);
}

const DEFAULT_SIZE = { width: 1440, height: 900 };
const CASCADE_OFFSET = 28;

/** A new window steps down and right from the one in front, and starts again at the corner once it would run off screen. */
function cascadeBounds(): Partial<Electron.Rectangle> {
  const from = BrowserWindow.getFocusedWindow() ?? [...windows.values()].at(-1)?.window;
  if (!from || from.isDestroyed()) return DEFAULT_SIZE;
  const { x, y, width, height } = from.getNormalBounds();
  const area = screen.getDisplayMatching(from.getBounds()).workArea;
  const next = { x: x + CASCADE_OFFSET, y: y + CASCADE_OFFSET, width, height };
  const offScreen = next.x + width > area.x + area.width || next.y + height > area.y + area.height;
  return offScreen ? { x: area.x, y: area.y, width, height } : next;
}

function createWindow(request: OpenRequest): ProjectWindow {
  const assetHost = `w${++windowCount}`;
  const window = new BrowserWindow({
    ...cascadeBounds(),
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#ECEAE5",
    title: "lamsa",
    icon: join(here, "../../resources/icons/512.png"),
    show: !hidden,
    webPreferences: {
      preload: join(here, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
      offscreen: hidden,
      additionalArguments: [`--lamsa-asset-host=${assetHost}`],
    },
  });
  window.setMenuBarVisibility(false);
  const send = (channel: string, value: unknown) => {
    if (!window.isDestroyed()) window.webContents.send(channel, value);
  };
  const service = new ProjectService({
    external: (change) => {
      send("external-change", { ...change, agent: agent.activeName() });
      agent.noteChange(change);
    },
    reloaded: (snapshot) => send("project-reloaded", snapshot),
    activity: (activity) => send("agent-activity", activity),
  });
  const agent = createAgent({ service, send });
  const comments = new CommentsService((state) => send("comments-changed", state));
  const snapshots = new FrameSnapshots((page) => loadPage(page, "snapshot.html"));
  const context: ProjectWindow = { window, assetHost, service, comments, agent, snapshots, send, pending: request, opening: rootOf(request) };
  const id = window.webContents.id;
  windows.set(id, context);
  window.on("closed", () => {
    windows.delete(id);
    agent.stop();
    snapshots.close();
    void service.close();
    void comments.close();
  });
  void loadPage(window, "index.html");
  return context;
}

/** Loads one of the renderer's pages, from the dev server when there is one. */
function loadPage(window: BrowserWindow, page: string): Promise<void> {
  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) return window.loadURL(page === "index.html" ? devServer : new URL(page, `${devServer.replace(/\/?$/, "/")}`).href);
  return window.loadFile(join(here, "../renderer", page));
}

/** Brings a window to the front. Hidden runs (tests) leave windows hidden, since focusing one would show it. */
function reveal(context: ProjectWindow) {
  if (hidden) return;
  if (context.window.isMinimized()) context.window.restore();
  context.window.focus();
}

async function openIn(context: ProjectWindow, { root, file }: { root: string; file?: string }): Promise<ProjectSnapshot> {
  context.opening = root;
  const snapshot = await context.service.openProject(root, { file });
  await context.comments.open({ root, config: snapshot.config });
  context.opening = undefined;
  context.uninitialised = undefined;
  await rememberProject(root);
  context.window.setTitle(`${snapshot.name} · lamsa`);
  return snapshot;
}

/**
 * Where `lamsa open` lands: the window that already has the project (which then selects what was asked for), an
 * empty window, or a new one. A window with another project in it is never replaced.
 */
function route(request: OpenRequest) {
  const root = rootOf(request);
  const front = BrowserWindow.getFocusedWindow();
  const existing = root
    ? windowFor(root)
    : request.root
      ? undefined
      : ((front && windows.get(front.webContents.id)) ?? [...windows.values()].at(-1));
  if (existing) {
    reveal(existing);
    const target = { file: request.file, select: request.select };
    // A page still loading takes the request when it asks for its project; it can't hear it yet.
    if (existing.pending.root) existing.pending = { ...existing.pending, ...withoutEmpty(target) };
    else existing.send("open-request", target);
    return;
  }
  const empty = [...windows.values()].find(isEmpty);
  if (!empty) {
    createWindow(request);
    return;
  }
  empty.pending = request;
  empty.opening = root;
  reveal(empty);
  empty.window.webContents.reload();
}

const withoutEmpty = (request: OpenRequest): OpenRequest =>
  Object.fromEntries(Object.entries(request).filter(([, value]) => value !== undefined)) as OpenRequest;

/** Registers an IPC handler that gets the window that sent the call. */
function handle<Args extends unknown[]>(channel: string, listener: (context: ProjectWindow, ...args: Args) => unknown) {
  ipcMain.handle(channel, (event, ...args) => {
    const context = windows.get(event.sender.id);
    if (!context) throw new Error("this window is closing");
    return listener(context, ...(args as Args));
  });
}

function registerIpc() {
  handle("welcome", async (context): Promise<WelcomeState> => ({ recent: await readRecent(), uninitialised: context.uninitialised }));
  handle("forget-recent", async (context, root: string): Promise<WelcomeState> => {
    const recent = (await readRecent()).filter((entry) => entry.root !== root);
    await writeRecent(recent);
    return { recent, uninitialised: context.uninitialised };
  });

  handle("choose-folder", async (context) => {
    const result = await dialog.showOpenDialog(context.window, { properties: ["openDirectory"] });
    const folder = result.filePaths[0];
    if (result.canceled || !folder) return {};
    const root = findProjectRoot(folder);
    if (root) return { root };
    // A window with a project keeps it; the setup instructions for the new folder get a window of their own.
    if (projectOf(context)) {
      createWindow({ root: folder });
      return {};
    }
    context.uninitialised = folder;
    return { uninitialised: folder };
  });

  /** Opens a project here if this window is empty; otherwise in its own window. Null when it opened elsewhere. */
  handle("open-project", async (context, requested: string): Promise<ProjectSnapshot | null> => {
    const root = findProjectRoot(requested);
    if (!root) throw new Error(`no lamsa.config.json in ${requested}`);
    if (projectOf(context) === root) return context.service.root ? context.service.snapshot() : null;
    const elsewhere = windowFor(root);
    if (elsewhere) {
      reveal(elsewhere);
      return null;
    }
    if (projectOf(context)) {
      createWindow({ root });
      return null;
    }
    return openIn(context, { root });
  });

  handle("close-project", async (context) => {
    // The agent chat runs in the project's folder, so its turn ends with it.
    context.agent.stop();
    context.opening = undefined;
    await context.service.close();
    await context.comments.close();
    context.window.setTitle("lamsa");
  });

  handle("current", async (context) => {
    const request = context.pending;
    context.pending = {};
    const root = rootOf(request);
    if (request.root && !root) context.uninitialised = request.root;
    if (!root) {
      context.opening = undefined;
      return context.service.root ? context.service.snapshot() : null;
    }
    const snapshot = await openIn(context, { root, file: request.file });
    if (request.file || request.select?.length) {
      setTimeout(() => context.send("open-request", { file: request.file, select: request.select }), 50);
    }
    return snapshot;
  });

  handle("apply-changes", (context, changes: Change[]) => context.service.applyChanges(changes));
  handle("comments", (context) => context.comments.current());
  handle("update-comments", (context, request: CommentRequest) => context.comments.apply(request));
  handle("icons", (context, names: string[]) => context.service.icons(names));
  ipcMain.handle("format-css", (_event, css: string, scope?: CssScope) => (scope === "file" ? formatFileCss(css) : formatNodeCss(css)));
  ipcMain.handle("check-css", (_event, css: string, scope?: CssScope) => (scope === "file" ? checkFileCss(css) : checkNodeCss(css)));
  ipcMain.handle("icon-names", () => [...lucideIconNames()].sort());
  handle("set-selection", (context, selection: string[], file?: string) => context.service.setSelection(selection, file));
  handle("pick-design-files", async (context) => {
    const root = context.service.root;
    const result = await dialog.showOpenDialog(context.window, {
      title: "Add design files",
      defaultPath: root ? (existsSync(join(root, "designs")) ? join(root, "designs") : root) : undefined,
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "lamsa design files", extensions: ["json"] }],
    });
    return result.canceled ? [] : result.filePaths;
  });
  handle("add-files", (context, paths: string[]) => context.service.addFiles(paths));
  handle("set-open-files", (context, paths: string[]) => context.service.setOpenFiles(paths));
  handle("close-file", (context, path: string) => context.service.closeFile(path));

  handle("render", async (context, ids: string[], mode?: "light" | "dark") => {
    const root = context.service.root;
    if (!root) return [];
    const { openWorkspace, renderFrames } = await import("@lamsa/cli");
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

  handle("frame-snapshot", (context, request: FrameSnapshotRequest) => context.snapshots.capture(request));

  handle("import-image", async (context) => {
    const root = context.service.root;
    const assets = context.service.assetsDir;
    if (!root || !assets) return null;
    const result = await dialog.showOpenDialog(context.window, {
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

  registerAgentIpc({ ipcMain, agentFor: (sender) => windows.get(sender.id)?.agent });
}

const launchRequest = parseArgs(process.argv);
const gotLock = process.env.LAMSA_MULTI_INSTANCE ? true : app.requestSingleInstanceLock({ ...launchRequest });
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv, _cwd, additionalData) => {
    const request = (additionalData as OpenRequest | null) ?? parseArgs(argv);
    void app.whenReady().then(() => route(request));
  });

  void app.whenReady().then(() => {
    protocol.handle("lamsa-asset", (request) => {
      const url = new URL(request.url);
      const owner = [...windows.values()].find((context) => context.assetHost === url.host);
      const path = owner?.service.assetPath(url.pathname.replace(/^\/+/, ""));
      if (!path) return new Response("not found", { status: 404 });
      return net.fetch(pathToFileURL(path).href);
    });
    registerIpc();
    createWindow(launchRequest);
    startUpdates();
  });

  app.on("window-all-closed", () => {
    app.quit();
  });
}
