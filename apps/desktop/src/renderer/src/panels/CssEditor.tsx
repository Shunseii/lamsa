import { autocompletion, completionKeymap, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { css, cssLanguage } from "@codemirror/lang-css";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, placeholder, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { Token } from "@lamsa/schema";
import { useEffect, useRef, useState } from "react";
import type { CssScope } from "../../../shared/api";
import { api } from "../lib/store";
import { Popover } from "./Popover";

const BEZIER = /cubic-bezier\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/g;

export type Curve = [number, number, number, number];

interface OpenCurve {
  from: number;
  to: number;
  curve: Curve;
  anchor: HTMLElement;
}

const highlight = HighlightStyle.define([
  { tag: tags.propertyName, color: "var(--color-ink-2)" },
  { tag: [tags.className, tags.tagName, tags.labelName, tags.attributeName], color: "var(--color-accent)" },
  { tag: [tags.number, tags.unit], color: "#8e3fa0" },
  { tag: [tags.string, tags.atom, tags.keyword], color: "#1d7a80" },
  { tag: tags.comment, color: "var(--color-ink-3)", fontStyle: "italic" },
  { tag: tags.punctuation, color: "var(--color-ink-3)" },
]);

const theme = EditorView.theme({
  "&": { fontSize: "12px", background: "var(--color-surface-2)", borderRadius: "8px", border: "1px solid transparent" },
  "&.cm-focused": { outline: "none", borderColor: "var(--color-accent)", background: "var(--color-surface)" },
  ".cm-content": { fontFamily: "var(--font-mono)", padding: "8px 0", caretColor: "var(--color-accent)" },
  ".cm-line": { padding: "0 10px" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
  // Out of flow, so a multi-line placeholder doesn't make the empty line (and its cursor) as tall as itself.
  ".cm-placeholder": { color: "var(--color-ink-3)", position: "absolute", pointerEvents: "none" },
  ".cm-content:has(.cm-placeholder)": { minHeight: "calc(3.1em + 16px)" },
  ".cm-tooltip-autocomplete": { fontFamily: "var(--font-mono)", fontSize: "12px", borderRadius: "8px", border: "1px solid var(--color-line)", boxShadow: "var(--shadow-panel)", background: "var(--color-surface)" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { background: "var(--color-accent-soft)", color: "var(--color-accent)" },
  ".cm-completionDetail": { color: "var(--color-ink-3)", marginLeft: "8px", fontStyle: "normal" },
  ".cm-curve-button": { display: "inline-grid", placeItems: "center", width: "16px", height: "16px", marginLeft: "4px", verticalAlign: "-3px", borderRadius: "4px", color: "var(--color-accent)", background: "var(--color-accent-soft)", cursor: "pointer" },
});

class CurveWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly curve: Curve,
    readonly open: (curve: OpenCurve) => void,
  ) {
    super();
  }
  eq(other: CurveWidget) {
    return other.from === this.from && other.to === this.to && other.curve.join() === this.curve.join();
  }
  toDOM() {
    const button = document.createElement("span");
    button.className = "cm-curve-button";
    button.title = "Edit curve";
    button.setAttribute("data-testid", "curve-button");
    button.innerHTML =
      '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M3 20C10 20 8 4 21 4"/></svg>';
    button.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.open({ from: this.from, to: this.to, curve: this.curve, anchor: button });
    });
    return button;
  }
  ignoreEvent() {
    return true;
  }
}

/** A curve button after every `cubic-bezier(…)` value; nothing for keywords or tokens. */
function curveButtons(open: (curve: OpenCurve) => void): Extension {
  const build = (view: EditorView): DecorationSet => {
    const widgets = [];
    const text = view.state.doc.toString();
    for (const match of text.matchAll(BEZIER)) {
      const from = match.index!;
      const to = from + match[0].length;
      const curve = match.slice(1, 5).map(Number) as Curve;
      widgets.push(Decoration.widget({ widget: new CurveWidget(from, to, curve, open), side: 1 }).range(to));
    }
    return Decoration.set(widgets);
  };
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged) this.decorations = build(update.view);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

const STATE_SNIPPETS = ["&:hover", "&:active", "&:focus-visible", "&:disabled", '&[data-state="open"]', '[data-state="open"] &'];

function lamsaCompletions({ tokens, keyframes }: { tokens: Record<string, Token>; keyframes: string[] }) {
  const variables = Object.values(tokens)
    .filter((token) => token.css.startsWith("var("))
    .map((token) => ({ name: token.css.slice(4, -1), value: token.values.light }));
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const variable = /var\((--[\w-]*)$/.exec(before);
    if (variable) {
      return {
        from: context.pos - variable[1]!.length,
        options: variables.map((v) => ({ label: v.name, detail: v.value, type: "variable" })),
        validFor: /^--[\w-]*$/,
      };
    }
    const animation = /animation(?:-name)?\s*:\s*(?:[^;]*,\s*)?([\w-]*)$/.exec(before);
    if (animation && keyframes.length) {
      return {
        from: context.pos - animation[1]!.length,
        options: keyframes.map((name) => ({ label: name, detail: "@keyframes", type: "constant" })),
        validFor: /^[\w-]*$/,
      };
    }
    const nested = /^\s*(&[\w:-]*|\[[^\]{]*)$/.exec(before);
    if (nested) {
      return {
        from: context.pos - nested[1]!.length,
        options: STATE_SNIPPETS.map((label) => ({ label, apply: `${label} {\n  \n}`, type: "keyword" })),
      };
    }
    return null;
  };
}

function bezierPoint(t: number, curve: Curve) {
  const at = (p1: number, p2: number) => 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3;
  return { x: at(curve[0], curve[2]), y: at(curve[1], curve[3]) };
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Drag the two handles; the `cubic-bezier(…)` text updates as you go. */
export function CurveEditor({ curve, onChange }: { curve: Curve; onChange: (curve: Curve) => void }) {
  const W = 220;
  const H = 150;
  const PADDING = 30;
  const toX = (x: number) => x * W;
  const toY = (y: number) => (1 - y) * H;
  const path = Array.from({ length: 41 }, (_, i) => bezierPoint(i / 40, curve))
    .map((p, i) => `${i ? "L" : "M"}${toX(p.x).toFixed(1)},${toY(p.y).toFixed(1)}`)
    .join(" ");
  const latest = useRef(curve);
  latest.current = curve;
  const drag = (handle: 0 | 1) => (e: React.PointerEvent<SVGCircleElement>) => {
    const svg = (e.target as SVGElement).ownerSVGElement!;
    const box = svg.getBoundingClientRect();
    const move = (event: PointerEvent) => {
      const x = Math.min(1, Math.max(0, (event.clientX - box.left - PADDING) / W));
      const y = 1 - (event.clientY - box.top - PADDING) / H;
      const next = [...latest.current] as Curve;
      next[handle * 2] = round(x);
      next[handle * 2 + 1] = round(Math.min(2, Math.max(-1, y)));
      onChange(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <svg width={W + PADDING * 2} height={H + PADDING * 2} className="curve-editor" data-testid="curve-editor">
      <g transform={`translate(${PADDING} ${PADDING})`}>
        <rect width={W} height={H} fill="none" stroke="var(--color-line)" />
        <line x1={0} y1={H} x2={toX(curve[0])} y2={toY(curve[1])} stroke="var(--color-ink-3)" />
        <line x1={W} y1={0} x2={toX(curve[2])} y2={toY(curve[3])} stroke="var(--color-ink-3)" />
        <path d={path} fill="none" stroke="var(--color-accent)" strokeWidth={2} />
        <circle cx={toX(curve[0])} cy={toY(curve[1])} r={6} className="curve-handle" onPointerDown={drag(0)} />
        <circle cx={toX(curve[2])} cy={toY(curve[3])} r={6} className="curve-handle" onPointerDown={drag(1)} />
      </g>
    </svg>
  );
}

/**
 * A node's own CSS, as plain text: declarations and nested rules where `&` is the layer.
 * Formats and saves when it loses focus (or on Shift+Alt+F).
 */
export function CssEditor({
  value,
  onCommit,
  tokens,
  keyframes,
  placeholderText,
  scope = "node",
}: {
  value: string;
  onCommit: (css: string) => void;
  tokens: Record<string, Token>;
  keyframes: string[];
  placeholderText: string;
  scope?: CssScope;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const committed = useRef(value);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const [problems, setProblems] = useState<{ message: string; line?: number }[]>([]);
  const [curve, setCurve] = useState<OpenCurve | null>(null);

  const commit = async () => {
    const editor = view.current;
    if (!editor) return;
    const text = editor.state.doc.toString();
    const formatted = text.trim() ? await api().formatCss(text, scope) : "";
    if (formatted !== text) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: formatted } });
    if (formatted !== committed.current) {
      committed.current = formatted;
      commitRef.current(formatted);
    }
  };
  const commitLater = useRef(commit);
  commitLater.current = commit;

  useEffect(() => {
    let check: ReturnType<typeof setTimeout> | undefined;
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          indentOnInput(),
          bracketMatching(),
          css(),
          cssLanguage.data.of({ autocomplete: lamsaCompletions({ tokens, keyframes }) }),
          autocompletion({ activateOnTyping: true }),
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          placeholder(placeholderText),
          theme,
          curveButtons((open) => setCurve(open)),
          keymap.of([
            { key: "Shift-Alt-f", run: () => (void commitLater.current(), true) },
            ...completionKeymap,
            ...historyKeymap,
            indentWithTab,
            ...defaultKeymap,
          ]),
          EditorView.domEventHandlers({ blur: () => void commitLater.current() }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            clearTimeout(check);
            check = setTimeout(() => {
              const text = update.state.doc.toString();
              void (text.trim() ? api().checkCss(text, scope) : Promise.resolve([])).then(setProblems);
            }, 300);
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      clearTimeout(check);
      editor.destroy();
      view.current = null;
    };
    // The editor is created once per layer; later prop changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A change from disk (the agent, undo) replaces the text unless you're typing in it.
  useEffect(() => {
    const editor = view.current;
    committed.current = value;
    if (!editor || editor.hasFocus || editor.state.doc.toString() === value) return;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);

  // Drag handlers outlive renders, so the range being edited lives in a ref.
  const curveRef = useRef<OpenCurve | null>(null);
  curveRef.current = curve;
  const replaceCurve = (next: Curve) => {
    const editor = view.current;
    const open = curveRef.current;
    if (!editor || !open) return;
    const text = `cubic-bezier(${next.join(", ")})`;
    editor.dispatch({ changes: { from: open.from, to: open.to, insert: text } });
    const updated = { ...open, to: open.from + text.length, curve: next };
    curveRef.current = updated;
    setCurve(updated);
  };

  return (
    <div className="css-editor" data-testid="css-editor">
      <div ref={host} />
      {problems.map((problem, i) => (
        <div key={i} className="css-problem">
          {problem.line ? `Line ${problem.line}: ` : ""}
          {problem.message}
        </div>
      ))}
      {curve && (
        <Popover
          anchor={curve.anchor}
          width={300}
          onClose={() => {
            setCurve(null);
            void commit();
          }}
          testId="curve-popover"
        >
          <div className="curve-popover">
            <div className="curve-title">
              <span className="strong">cubic-bezier</span>
              <span className="muted">drag the handles</span>
            </div>
            <CurveEditor curve={curve.curve} onChange={replaceCurve} />
            <div className="input mono curve-value">cubic-bezier({curve.curve.join(", ")})</div>
          </div>
        </Popover>
      )}
    </div>
  );
}
