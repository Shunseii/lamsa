import { BrowserWindow } from "electron";
import type { FrameSnapshotRequest } from "../shared/api.js";

/** The largest bitmap side the page is asked for; the canvas picks a scale that stays under it. */
const MAX_SIDE = 4096;
/** The page closes after this long without a frame to draw; it holds a whole renderer process's memory. */
const IDLE_MS = 20_000;

/**
 * Draws top-level frames into small bitmaps for the canvas to show when it is zoomed far out (canvas/frameBitmaps.ts).
 * Each project window gets one hidden offscreen page, loaded from the same origin as the editor so its fonts and
 * assets resolve the same way, and frames are drawn one at a time.
 */
export class FrameSnapshots {
  private window: BrowserWindow | null = null;
  private ready: Promise<number> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private idle: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly load: (window: BrowserWindow) => Promise<void>) {}

  capture(request: FrameSnapshotRequest): Promise<Uint8Array | null> {
    clearTimeout(this.idle);
    this.waiting++;
    const run = this.queue.then(() => this.draw(request));
    this.queue = run.catch(() => undefined).finally(() => {
      if (--this.waiting === 0) this.idle = setTimeout(() => this.close(), IDLE_MS);
    });
    return run.catch(() => null);
  }

  close() {
    clearTimeout(this.idle);
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.ready = null;
  }

  /** Opens the page on first use; resolves to its device pixel ratio. */
  private open(): Promise<number> {
    if (this.ready && this.window && !this.window.isDestroyed()) return this.ready;
    const window = new BrowserWindow({
      show: false,
      width: 400,
      height: 400,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false },
    });
    this.window = window;
    this.ready = this.load(window).then(() => window.webContents.executeJavaScript("devicePixelRatio") as Promise<number>);
    return this.ready;
  }

  private async draw(request: FrameSnapshotRequest): Promise<Uint8Array | null> {
    const ratio = await this.open();
    const window = this.window;
    if (!window || window.isDestroyed()) return null;
    const pixels = (side: number) => Math.min(MAX_SIDE, Math.max(1, Math.ceil(side * request.scale)));
    const width = pixels(request.width);
    const height = pixels(request.height);
    // The window is sized in device-independent pixels; the bitmap comes back in device pixels.
    window.setContentSize(Math.max(1, Math.ceil(width / ratio)), Math.max(1, Math.ceil(height / ratio)));
    await window.webContents.executeJavaScript(`window.lamsaShowFrame(${JSON.stringify(request)})`);
    const image = await window.webContents.capturePage({ x: 0, y: 0, width: Math.ceil(width / ratio), height: Math.ceil(height / ratio) });
    if (image.isEmpty()) return null;
    return image.toPNG();
  }
}
