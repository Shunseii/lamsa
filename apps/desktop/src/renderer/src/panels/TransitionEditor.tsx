import {
  PAGE_PRESETS,
  pagePreset,
  setPagePreset,
  setTransitionDeclaration,
  transitionTargetsIn,
  transitionTiming,
  withTransitionTarget,
  type TransitionTarget,
} from "@lamsa/renderer";
import { AlertTriangle, ArrowRight, Check, ChevronDown, Play, Plus, Spline } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { patchNodes } from "../lib/edits";
import { descendantsOf, nodeTitle, type Model } from "../lib/model";
import { useEditor } from "../lib/store";
import { CssEditor, CurveEditor, type Curve } from "./CssEditor";
import { Popover } from "./Popover";
import { AutocompleteInput } from "./AutocompleteInput";
import { CommitInput } from "./PropertiesPanel";

const EASINGS = ["ease", "ease-out", "ease-in-out", "linear", "cubic-bezier(0.32, 0.72, 0, 1)", "cubic-bezier(0.23, 1, 0.32, 1)"];
const BEZIER = /^cubic-bezier\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$/;
const NAME = /^[a-z][\w-]*$/i;

const withUnit = (value: string) => (/^\d+(\.\d+)?$/.test(value.trim()) ? `${value.trim()}ms` : value.trim());

/** Every transition target a frame's layers carry, with the layers that carry it. */
function targetsIn(model: Model, rootId: string): Map<TransitionTarget, string[]> {
  const result = new Map<TransitionTarget, string[]>();
  for (const id of [rootId, ...descendantsOf(model, rootId)]) {
    for (const target of transitionTargetsIn(model.nodes[id]?.css)) result.set(target, [...(result.get(target) ?? []), id]);
  }
  return result;
}

/**
 * Edits the page transition from one frame to the next. Everything is written as plain CSS: timing
 * on `::view-transition-group(<target>)` in file CSS, and `view-transition-name` on the layers.
 */
export function TransitionEditor({ from, to, onEdited, onReplay }: { from: string; to: string; onEdited: () => void; onReplay: () => void }) {
  const model = useEditor((s) => s.model);
  const files = useEditor((s) => s.files);
  const commit = useEditor((s) => s.commit);
  const tokens = useEditor((s) => s.snapshot?.tokens.tokens ?? {});
  const [adding, setAdding] = useState(false);

  const homeFile = model.fileOf.get(from) ?? Object.keys(files)[0] ?? "";
  // Rules can live in any file (they all apply), so each one is edited where it already is.
  const fileWith = (has: (css: string) => boolean) => Object.keys(files).sort().find((path) => has(files[path]?.css ?? "")) ?? homeFile;
  const cssOf = (path: string) => files[path]?.css ?? "";
  const timingFile = (target: TransitionTarget) =>
    fileWith((css) => {
      const timing = transitionTiming(css, target);
      return !!(timing.duration || timing.easing);
    });
  const pageFile = fileWith((css) => pagePreset(css) !== "fade");
  const preset = pagePreset(cssOf(pageFile));

  const fromTargets = useMemo(() => targetsIn(model, from), [model, from]);
  const toTargets = useMemo(() => targetsIn(model, to), [model, to]);
  const shared = [...new Set([...fromTargets.keys(), ...toTargets.keys()])].sort();

  const writeCss = async (path: string, css: string) => {
    if (css === cssOf(path)) return;
    await commit("Edit transition", [{ file: path, css }]);
    onEdited();
  };

  const setTiming = (target: TransitionTarget, property: "animation-duration" | "animation-timing-function", value: string) => {
    const path = timingFile(target);
    void writeCss(path, setTransitionDeclaration(cssOf(path), { target, part: "group", direction: "any", property, value }));
  };

  const link = async (target: TransitionTarget, nodeId: string) => {
    await commit("Share layer", patchNodes(model, [nodeId], (node) => ({ ...node, css: withTransitionTarget(node.css, target) })));
    onEdited();
  };

  const fromName = nodeTitle(from, model.nodes[from]);
  const toName = nodeTitle(to, model.nodes[to]);

  return (
    <div className="transition-editor" data-testid="transition-editor">
      <div className="transition-head">
        <span className="strong truncate">{fromName}</span>
        <ArrowRight size={13} className="muted" />
        <span className="strong truncate">{toName}</span>
        <button className="icon-btn small push-right" onClick={onReplay} aria-label="Play this transition" title="Play this transition">
          <Play size={13} />
        </button>
      </div>

      <div className="transition-section">
        <div className="transition-label">Page</div>
        <div className="segmented small" data-testid="page-preset">
          {PAGE_PRESETS.map((option) => (
            <button
              key={option.value}
              className={preset === option.value ? "is-on" : ""}
              onClick={() => void writeCss(pageFile, setPagePreset(cssOf(pageFile), option.value))}
              title={preset === "custom" ? "Replaces the custom page rules in file CSS" : undefined}
            >
              {option.label}
            </button>
          ))}
        </div>
        {preset === "custom" && <div className="muted small">Custom rules in file CSS. Pick a preset to replace them.</div>}
        <TimingRow target="root" timing={transitionTiming(cssOf(timingFile("root")), "root")} onChange={setTiming} />
      </div>

      <div className="transition-section">
        <div className="transition-label">Shared layers</div>
        {shared.length === 0 && <div className="muted small">Nothing morphs between these frames yet. Share a layer that appears on both.</div>}
        {shared.map((target) => {
          const onFrom = fromTargets.get(target) ?? [];
          const onTo = toTargets.get(target) ?? [];
          // The frame without this layer, if only one of them has it.
          const lacking = onFrom.length === 0 ? to : onTo.length === 0 ? from : null;
          const title = (id: string) => nodeTitle(id, model.nodes[id]);
          return (
            <div key={target} className="shared-row" data-testid="shared-row" data-target={target}>
              <div className="shared-name">
                <span className="mono">{target}</span>
                {lacking ? (
                  <span className="shared-warn">
                    <AlertTriangle size={12} /> only on {title(lacking === to ? from : to)}
                  </span>
                ) : (
                  <span className="shared-ok">
                    <Check size={12} /> both
                  </span>
                )}
              </div>
              {lacking ? (
                <LayerPicker model={model} rootId={lacking} placeholder={`Link a layer on ${title(lacking)}…`} onPick={(id) => void link(target, id)} testId="link-layer" />
              ) : (
                <TimingRow target={target} timing={transitionTiming(cssOf(timingFile(target)), target)} onChange={setTiming} />
              )}
            </div>
          );
        })}
        {adding ? (
          <AddShared
            model={model}
            from={from}
            to={to}
            taken={shared}
            onCancel={() => setAdding(false)}
            onAdd={async ({ name, fromId, toId }) => {
              await commit("Share layer", [
                ...patchNodes(model, [fromId], (node) => ({ ...node, css: withTransitionTarget(node.css, name) })),
                ...patchNodes(model, [toId], (node) => ({ ...node, css: withTransitionTarget(node.css, name) })),
              ]);
              setAdding(false);
              onEdited();
            }}
          />
        ) : (
          <button className="ghost-btn small" onClick={() => setAdding(true)} data-testid="share-layer">
            <Plus size={13} /> Share a layer
          </button>
        )}
      </div>

      <details className="transition-section transition-css">
        <summary className="transition-label">File CSS · {homeFile.split("/").pop()}</summary>
        <CssEditor
          key={homeFile}
          scope="file"
          value={cssOf(homeFile)}
          tokens={tokens}
          keyframes={[...cssOf(homeFile).matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]!)}
          placeholderText={"@keyframes …\n::view-transition-group(…) { … }"}
          onCommit={(css) => void writeCss(homeFile, css)}
        />
      </details>
    </div>
  );
}

function TimingRow({
  target,
  timing,
  onChange,
}: {
  target: TransitionTarget;
  timing: { duration?: string; easing?: string };
  onChange: (target: TransitionTarget, property: "animation-duration" | "animation-timing-function", value: string) => void;
}) {
  return (
    <div className="timing-row">
      <div className="field-control timing-duration">
        <CommitInput
          className="input bare mono"
          value={timing.duration ?? ""}
          placeholder="250ms"
          onCommit={(value) => onChange(target, "animation-duration", withUnit(value))}
        />
      </div>
      <EasingField value={timing.easing ?? ""} onCommit={(value) => onChange(target, "animation-timing-function", value)} />
    </div>
  );
}

function EasingField({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const button = useRef<HTMLButtonElement>(null);
  const [curve, setCurve] = useState<Curve | null>(null);
  const control = useRef<HTMLDivElement>(null);
  const open = () => {
    const match = BEZIER.exec(value);
    setCurve(match ? [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])] : [0.25, 0.1, 0.25, 1]);
  };
  return (
    <div ref={control} className="field-control timing-easing">
      <AutocompleteInput
        className="input mono"
        value={value}
        placeholder="ease"
        anchor={() => control.current}
        openOnFocus
        suggest={(draft) => {
          const needle = draft.trim() === value ? "" : draft.trim().toLowerCase();
          return EASINGS.filter((easing) => easing.includes(needle)).map((easing) => ({ key: easing, label: easing, apply: easing }));
        }}
        onCommit={(v) => onCommit(v.trim())}
      />
      <button ref={button} className="icon-btn tiny" onClick={open} aria-label="Edit curve" title="Edit curve">
        <Spline size={13} />
      </button>
      {curve && (
        <Popover
          anchor={button.current}
          width={300}
          onClose={() => {
            onCommit(`cubic-bezier(${curve.join(", ")})`);
            setCurve(null);
          }}
          testId="curve-popover"
        >
          <div className="curve-popover">
            <div className="curve-title">
              <span className="strong">cubic-bezier</span>
              <span className="muted">drag the handles</span>
            </div>
            <CurveEditor curve={curve} onChange={setCurve} />
            <div className="input mono curve-value">cubic-bezier({curve.join(", ")})</div>
          </div>
        </Popover>
      )}
    </div>
  );
}

/**
 * Picks a layer in one frame from a menu. A layer that already has a transition name shows it and
 * can't be picked, so linking never overwrites another name.
 */
function LayerPicker({
  model,
  rootId,
  value,
  placeholder,
  onPick,
  testId,
}: {
  model: Model;
  rootId: string;
  value?: string;
  placeholder: string;
  onPick: (id: string) => void;
  testId?: string;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const depthOf = (id: string) => {
    let depth = 0;
    for (let at = model.nodes[id]?.parentId; at && at !== model.nodes[rootId]?.parentId; at = model.nodes[at]?.parentId) depth++;
    return depth;
  };
  return (
    <>
      <button ref={button} className={cn("layer-picker", { "is-empty": !value })} onClick={() => setOpen((o) => !o)} data-testid={testId}>
        <span className="truncate">{value ? nodeTitle(value, model.nodes[value]) : placeholder}</span>
        <ChevronDown size={12} className="muted" />
      </button>
      {open && (
        <Popover anchor={button.current} width={Math.max(220, button.current?.offsetWidth ?? 0)} onClose={() => setOpen(false)} testId="layer-picker-menu">
          <div className="popover-list">
            {[rootId, ...descendantsOf(model, rootId)].map((id) => {
              const existing = transitionTargetsIn(model.nodes[id]?.css);
              return (
                <button
                  key={id}
                  className={cn("menu-item", { "is-active": id === value })}
                  style={{ paddingLeft: 10 + depthOf(id) * 12 }}
                  disabled={existing.length > 0}
                  data-layer-id={id}
                  onClick={() => {
                    setOpen(false);
                    onPick(id);
                  }}
                >
                  <span className="truncate">{nodeTitle(id, model.nodes[id])}</span>
                  {existing.length > 0 && <span className="mono muted push-right">{existing.join(", ")}</span>}
                  {id === value && <Check size={12} className="accent push-right" />}
                </button>
              );
            })}
          </div>
        </Popover>
      )}
    </>
  );
}

function AddShared({
  model,
  from,
  to,
  taken,
  onAdd,
  onCancel,
}: {
  model: Model;
  from: string;
  to: string;
  taken: string[];
  onAdd: (picked: { name: string; fromId: string; toId: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const valid = NAME.test(name) && !["root", "none", "auto"].includes(name) && !taken.includes(name) && fromId && toId;
  return (
    <div className="add-shared" data-testid="add-shared">
      <input className="input mono small" placeholder="name, e.g. order-card" value={name} onChange={(e) => setName(e.target.value.trim())} autoFocus />
      <LayerPicker model={model} rootId={from} value={fromId || undefined} placeholder={`On ${nodeTitle(from, model.nodes[from])}…`} onPick={setFromId} testId="pick-from" />
      <LayerPicker model={model} rootId={to} value={toId || undefined} placeholder={`On ${nodeTitle(to, model.nodes[to])}…`} onPick={setToId} testId="pick-to" />
      <div className="add-shared-actions">
        <button className="ghost-btn small" onClick={onCancel}>
          Cancel
        </button>
        <button className={cn("btn small", { "btn-accent": valid })} disabled={!valid} onClick={() => onAdd({ name, fromId, toId })}>
          Share
        </button>
      </div>
    </div>
  );
}
