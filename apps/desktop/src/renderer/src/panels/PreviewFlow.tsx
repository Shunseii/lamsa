import { baseCss, buildRenderTree, emulateReducedMotion, toHtml } from "@lamsa/renderer";
import { ArrowRight } from "lucide-react";
import { forwardRef, Fragment, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { assetUrl, localFontCss } from "../canvas/FrameView";
import { cn } from "../lib/cn";
import { nodeTitle } from "../lib/model";
import { useEditor } from "../lib/store";

/** How long each frame holds before Play moves on, at 1×. */
const HOLD_MS = 900;

export interface PreviewFlowHandle {
  step(delta: 1 | -1): void;
  /** Shows frame `pair`, then plays the transition to the next one. */
  play(pair: number): void;
  /** Plays `pair` once the document has reloaded with an edit (or right away if nothing reloads). */
  playAfterEdit(pair: number): void;
}

interface Page {
  id: string;
  html: string;
  css: string;
  mode: string;
}

interface Props {
  ids: string[];
  speed: number;
  reduced: boolean;
  loop: boolean;
  generation: number;
  zoom: number;
  maxSize: { width: number; height: number };
  /** The transition being edited: from frame `pair` to `pair + 1`. */
  pair: number;
  onPair: (pair: number) => void;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Plays page transitions between top-level frames. The frames render into one iframe document and
 * each step swaps them inside `document.startViewTransition`, so `view-transition-name` on nodes and
 * `::view-transition-*` rules in file CSS animate it. (View transitions don't reach into the shadow
 * roots the other preview cells use, hence the iframe.) Steps carry a `forward` or `back` type for
 * `:active-view-transition-type()`.
 */
export const PreviewFlow = forwardRef<PreviewFlowHandle, Props>(function PreviewFlow({ ids, speed, reduced, loop, generation, zoom, maxSize, pair, onPair }, ref) {
  const model = useEditor((s) => s.model);
  const tokens = useEditor((s) => s.snapshot?.tokens);
  const fontCss = useEditor((s) => s.snapshot?.fontCss ?? "");
  const fontLinks = useEditor((s) => s.snapshot?.fontLinks);
  const icons = useEditor((s) => s.icons);
  const canvasMode = useEditor((s) => s.canvasMode);
  const frame = useRef<HTMLIFrameElement>(null);
  const [step, setStep] = useState(0);
  const stepRef = useRef(0);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const onPairRef = useRef(onPair);
  onPairRef.current = onPair;
  const queued = useRef<{ pair: number; timer: ReturnType<typeof setTimeout> } | null>(null);

  const pages = useMemo<Page[]>(() => {
    if (!tokens) return [];
    return ids
      .filter((id) => model.nodes[id])
      .map((id) => {
        const result = buildRenderTree({
          nodes: model.nodes,
          rootId: id,
          tokens,
          canvasMode,
          iconSvg: (name) => icons[name] || undefined,
          assetUrl,
          fileCss: model.fileCss,
        });
        return { id, html: toHtml(result.root), css: result.css, mode: result.mode };
      });
  }, [ids, model, tokens, icons, canvasMode]);

  const doc = useMemo(() => {
    const first = pages[0];
    if (!tokens || !first) return "";
    const css = pages.map((page) => page.css).join("\n");
    const links = (fontLinks ?? []).map((href) => `<link rel="stylesheet" href="${href.replace(/"/g, "&quot;")}">`).join("");
    return `<!doctype html><html><head><meta charset="utf-8">${links}<style>${baseCss(tokens)}
${tokens.css}
${localFontCss(fontCss)}
html, body { margin: 0; background: transparent; }
${reduced ? emulateReducedMotion(css) : css}</style></head><body><div id="lamsa-render" class="lamsa-surface ${first.mode}" style="display: inline-block">${first.html}</div></body></html>`;
  }, [pages, tokens, fontCss, fontLinks, reduced]);

  const surface = () => frame.current?.contentDocument?.getElementById("lamsa-render") ?? null;

  const show = useCallback(
    (next: number, type: "forward" | "back" | null): Promise<void> => {
      const document = frame.current?.contentDocument;
      const element = surface();
      const page = pages[next];
      if (!document || !element || !page) return Promise.resolve();
      stepRef.current = next;
      setStep(next);
      const swap = () => {
        element.className = `lamsa-surface ${page.mode}`;
        element.innerHTML = page.html;
      };
      if (!type) {
        swap();
        return Promise.resolve();
      }
      onPairRef.current(type === "forward" ? next - 1 : next);
      const transition = document.startViewTransition({ update: swap, types: [type] });
      transition.ready.then(() => document.getAnimations().forEach((animation) => (animation.playbackRate = speedRef.current))).catch(() => {});
      return transition.finished.catch(() => {});
    },
    [pages],
  );

  // Every frame is measured once so the stage fits the largest and never jumps between steps.
  const onLoad = () => {
    const element = surface();
    if (!element) return;
    let w = 0;
    let h = 0;
    for (const page of pages) {
      element.innerHTML = page.html;
      w = Math.max(w, element.offsetWidth);
      h = Math.max(h, element.offsetHeight);
    }
    setSize({ w, h });
    void show(Math.min(stepRef.current, pages.length - 1), null);
    const waiting = queued.current;
    if (waiting) {
      clearTimeout(waiting.timer);
      queued.current = null;
      void play(waiting.pair);
    }
  };

  const play = async (index: number) => {
    if (index < 0 || index + 1 >= pages.length) return;
    await show(index, null);
    await wait(120);
    await show(index + 1, "forward");
  };

  useImperativeHandle(ref, () => ({
    step(delta) {
      const next = stepRef.current + delta;
      if (next < 0 || next >= pages.length) return;
      void show(next, delta > 0 ? "forward" : "back");
    },
    play(index) {
      void play(index);
    },
    playAfterEdit(index) {
      if (queued.current) clearTimeout(queued.current.timer);
      const timer = setTimeout(() => {
        queued.current = null;
        void play(index);
      }, 400);
      queued.current = { pair: index, timer };
    },
  }));

  // Play: from the first frame through each transition in order, then again while Loop is on.
  useEffect(() => {
    if (generation === 0 || !pages.length) return;
    let cancelled = false;
    void (async () => {
      do {
        await show(0, null);
        for (let next = 1; next < pages.length && !cancelled; next++) {
          await wait(HOLD_MS / speedRef.current);
          if (!cancelled) await show(next, "forward");
        }
        if (loop && !cancelled) await wait(HOLD_MS / speedRef.current);
      } while (loop && !cancelled);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation, loop]);

  const fit = size ? Math.min(1, maxSize.width / size.w, maxSize.height / size.h) : 1;
  const scale = fit * zoom;

  return (
    <div className="preview-cell">
      <div className="preview-cell-label flow-strip" data-testid="flow-strip">
        {pages.map((page, i) => (
          <Fragment key={page.id}>
            {i > 0 && (
              <button
                className={cn("flow-arrow", { "is-on": pair === i - 1 })}
                onClick={() => {
                  onPair(i - 1);
                  void play(i - 1);
                }}
                aria-label={`Play ${nodeTitle(pages[i - 1]!.id, model.nodes[pages[i - 1]!.id])} to ${nodeTitle(page.id, model.nodes[page.id])}`}
                title="Play and edit this transition"
                data-testid="flow-arrow"
              >
                <ArrowRight size={14} />
              </button>
            )}
            <button className={cn("flow-chip", { "is-current": step === i })} onClick={() => void show(i, null)} title="Show this frame">
              {nodeTitle(page.id, model.nodes[page.id])}
            </button>
          </Fragment>
        ))}
        <span className="mono muted push-right" data-testid="preview-flow-step">
          {step + 1} / {pages.length}
        </span>
        {size && scale !== 1 && <span className="mono muted">{Math.round(scale * 100)}%</span>}
      </div>
      <div className="preview-viewport" style={size ? { width: size.w * scale, height: size.h * scale } : { width: 120, height: 80 }}>
        <iframe
          ref={frame}
          className="preview-flow-frame"
          data-testid="preview-flow"
          title="Page transition preview"
          srcDoc={doc}
          onLoad={onLoad}
          style={size ? { width: size.w, height: size.h, transform: scale === 1 ? undefined : `scale(${scale})` } : undefined}
        />
      </div>
    </div>
  );
});
