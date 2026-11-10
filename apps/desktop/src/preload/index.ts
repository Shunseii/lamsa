import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { LamsaApi } from "../shared/api.js";

function listen<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: LamsaApi = {
  welcome: () => ipcRenderer.invoke("welcome"),
  chooseFolder: () => ipcRenderer.invoke("choose-folder"),
  openProject: (root) => ipcRenderer.invoke("open-project", root),
  current: () => ipcRenderer.invoke("current"),
  applyChanges: (changes) => ipcRenderer.invoke("apply-changes", changes),
  icons: (names) => ipcRenderer.invoke("icons", names),
  setSelection: (selection, file) => ipcRenderer.invoke("set-selection", selection, file),
  render: (ids, mode) => ipcRenderer.invoke("render", ids, mode),
  importImage: () => ipcRenderer.invoke("import-image"),
  revealPath: (path) => ipcRenderer.invoke("reveal-path", path),
  terminalStart: (cols, rows) => ipcRenderer.invoke("terminal-start", cols, rows),
  terminalWrite: (data) => ipcRenderer.send("terminal-write", data),
  terminalResize: (cols, rows) => ipcRenderer.send("terminal-resize", cols, rows),
  terminalExternal: () => ipcRenderer.invoke("terminal-external"),
  onExternalChange: (listener) => listen("external-change", listener),
  onOpenRequest: (listener) => listen("open-request", listener),
  onTerminalData: (listener) => listen("terminal-data", listener),
  onTerminalExit: (listener) => listen("terminal-exit", listener),
  onProjectReloaded: (listener) => listen("project-reloaded", listener),
};

contextBridge.exposeInMainWorld("lamsa", api);
