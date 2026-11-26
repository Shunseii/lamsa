import { app, BrowserWindow, ipcMain, shell } from "electron";
import electronUpdater from "electron-updater";
import type { UpdateStatus } from "../shared/api.js";

const RELEASES_PAGE = "https://github.com/Shunseii/lamsa/releases/latest";
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** The macOS app and the AppImage can replace themselves; the .deb can only point to the download. */
const canInstallItself = () => process.platform === "darwin" || Boolean(process.env.APPIMAGE);

let status: UpdateStatus = { state: "none" };

function publish(next: UpdateStatus) {
  status = next;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("update-status", status);
  }
}

/**
 * Checks GitHub releases for a newer version at launch and every few hours. Where the app can update
 * itself it downloads in the background and installs on quit (or on Restart); otherwise it only says a
 * version is available. Skipped outside packaged builds and in hidden test runs unless LAMSA_UPDATE_FEED is set.
 */
export function startUpdates(): void {
  ipcMain.handle("update-status", () => status);
  ipcMain.handle("install-update", () => {
    if (status.state === "ready") electronUpdater.autoUpdater.quitAndInstall();
  });
  ipcMain.handle("open-update-download", () => shell.openExternal(RELEASES_PAGE));
  // LAMSA_UPDATE_FEED points at a folder of latest-*.yml files instead of GitHub, for testing.
  const feed = process.env.LAMSA_UPDATE_FEED;
  if (!app.isPackaged || process.env.LAMSA_NO_UPDATE_CHECK || (process.env.LAMSA_HIDDEN && !feed)) return;

  const { autoUpdater } = electronUpdater;
  if (feed) autoUpdater.setFeedURL({ provider: "generic", url: feed });
  autoUpdater.logger = null;
  autoUpdater.allowPrerelease = false;
  autoUpdater.autoDownload = canInstallItself();
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-available", (info) => {
    if (!canInstallItself()) publish({ state: "available", version: info.version });
  });
  autoUpdater.on("update-downloaded", (info) => publish({ state: "ready", version: info.version }));
  // Offline or rate-limited: the next check tries again.
  autoUpdater.on("error", () => {});

  const check = () => void autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, CHECK_EVERY_MS);
}
