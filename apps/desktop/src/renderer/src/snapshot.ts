/**
 * The hidden page the main process draws frame bitmaps in (main/frame-snapshots.ts). It shows one frame at a time,
 * exactly as the canvas renders it, scaled so one CSS pixel here is one bitmap pixel.
 */
import { freezeAnimations } from "@lamsa/renderer";
import type { FrameSnapshotRequest } from "../../shared/api";

declare global {
  interface Window {
    /** Shows a frame and resolves once its fonts and images have loaded and it has been painted. */
    lamsaShowFrame(request: FrameSnapshotRequest): Promise<void>;
  }
}

const stage = document.getElementById("stage")!;
const host = stage.appendChild(document.createElement("div"));
const root = host.attachShadow({ mode: "open" });
const fontStyle = document.head.appendChild(document.createElement("style"));
const fontLinks = new Map<string, HTMLLinkElement>();

function useFonts(css: string, links: string[]) {
  if (fontStyle.textContent !== css) fontStyle.textContent = css;
  for (const href of links) {
    if (fontLinks.has(href)) continue;
    const link = document.head.appendChild(document.createElement("link"));
    link.rel = "stylesheet";
    link.href = href;
    fontLinks.set(href, link);
  }
}

const loaded = (link: HTMLLinkElement) =>
  link.sheet
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        link.addEventListener("load", () => resolve(), { once: true });
        link.addEventListener("error", () => resolve(), { once: true });
      });
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

window.lamsaShowFrame = async ({ html, fontCss, fontLinks: links, width, height, scale, inherited }) => {
  useFonts(fontCss, links);
  stage.style.transform = `scale(${scale / devicePixelRatio})`;
  host.removeAttribute("style");
  for (const [property, value] of Object.entries(inherited)) host.style.setProperty(property, value);
  host.style.width = `${width}px`;
  host.style.height = `${height}px`;
  root.innerHTML = html;
  // The markup's CSS animations start over in this page; put them at rest the way the canvas does.
  freezeAnimations(root);
  await Promise.all([...fontLinks.values()].map(loaded));
  // Laying the frame out starts its font loads, so `fonts.ready` waits for them.
  void host.offsetWidth;
  await document.fonts.ready;
  await Promise.all(Array.from(root.querySelectorAll("img"), (image) => image.decode().catch(() => undefined)));
  await nextFrame();
  await nextFrame();
};
