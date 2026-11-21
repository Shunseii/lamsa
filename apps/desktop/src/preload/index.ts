import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { LamsaApi } from "../shared/api.js";

function listen<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const ASSET_HOST_ARG = "--lamsa-asset-host=";

const api: LamsaApi = {
  assetHost: process.argv.find((arg) => arg.startsWith(ASSET_HOST_ARG))?.slice(ASSET_HOST_ARG.length) ?? "local",
  welcome: () => ipcRenderer.invoke("welcome"),
  forgetRecent: (root: string) => ipcRenderer.invoke("forget-recent", root),
  chooseFolder: () => ipcRenderer.invoke("choose-folder"),
  openProject: (root) => ipcRenderer.invoke("open-project", root),
  closeProject: () => ipcRenderer.invoke("close-project"),
  current: () => ipcRenderer.invoke("current"),
  applyChanges: (changes) => ipcRenderer.invoke("apply-changes", changes),
  icons: (names) => ipcRenderer.invoke("icons", names),
  formatCss: (css, scope) => ipcRenderer.invoke("format-css", css, scope),
  checkCss: (css, scope) => ipcRenderer.invoke("check-css", css, scope),
  iconNames: () => ipcRenderer.invoke("icon-names"),
  setSelection: (selection, file) => ipcRenderer.invoke("set-selection", selection, file),
  pickDesignFiles: () => ipcRenderer.invoke("pick-design-files"),
  addFiles: (paths) => ipcRenderer.invoke("add-files", paths),
  setOpenFiles: (paths) => ipcRenderer.invoke("set-open-files", paths),
  closeFile: (path) => ipcRenderer.invoke("close-file", path),
  render: (ids, mode) => ipcRenderer.invoke("render", ids, mode),
  importImage: () => ipcRenderer.invoke("import-image"),
  revealPath: (path) => ipcRenderer.invoke("reveal-path", path),
  agentStatus: () => ipcRenderer.invoke("agent-status"),
  agentSend: (request) => ipcRenderer.invoke("agent-send", request),
  agentStop: () => ipcRenderer.invoke("agent-stop"),
  agentSessions: () => ipcRenderer.invoke("agent-sessions"),
  agentTranscript: (sessionId) => ipcRenderer.invoke("agent-transcript", sessionId),
  agentTerminal: (request) => ipcRenderer.invoke("agent-terminal", request),
  agentSignIn: () => ipcRenderer.invoke("agent-sign-in"),
  comments: () => ipcRenderer.invoke("comments"),
  updateComments: (request) => ipcRenderer.invoke("update-comments", request),
  onCommentsChanged: (listener) => listen("comments-changed", listener),
  onExternalChange: (listener) => listen("external-change", listener),
  onAgentActivity: (listener) => listen("agent-activity", listener),
  onOpenRequest: (listener) => listen("open-request", listener),
  onAgentEvents: (listener) => listen("agent-events", listener),
  onAgentTerminal: (listener) => listen("agent-terminal", listener),
  onProjectReloaded: (listener) => listen("project-reloaded", listener),
};

contextBridge.exposeInMainWorld("lamsa", api);
