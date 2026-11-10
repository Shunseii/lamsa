import type { DesignNode, Token, TokenKind } from "@lamsa/schema";
import { Braces, ChevronDown, Component, Copy, Plus, Target, Unlink, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { detachInstance, parseStyleInput, patchNodes, setStyle } from "../lib/edits";
import { nodeTitle } from "../lib/model";
import { useEditor } from "../lib/store";
import { fitTo } from "../lib/viewport";

interface FieldDef {
  property: string;
  kind?: TokenKind;
  options?: string[];
}

const GROUPS: { title: string; fields: FieldDef[]; when?: (types: Set<DesignNode["type"]>) => boolean }[] = [
  {
    title: "Layout",
    fields: [
      { property: "display", options: ["block", "flex", "inline-flex", "grid", "none"] },
      { property: "flex-direction", options: ["row", "column", "row-reverse", "column-reverse"] },
      { property: "justify-content", options: ["start", "center", "end", "space-between", "space-around"] },
      { property: "align-items", options: ["stretch", "start", "center", "end", "baseline"] },
      { property: "gap", kind: "spacing" },
      { property: "flex", options: ["1", "none", "auto"] },
      { property: "position", options: ["static", "relative", "absolute"] },
    ],
  },
  {
    title: "Size",
    fields: [
      { property: "width", options: ["auto", "100%", "fit-content"] },
      { property: "height", options: ["auto", "100%", "fit-content"] },
      { property: "padding", kind: "spacing" },
      { property: "margin", kind: "spacing" },
    ],
  },
  {
    title: "Typography",
    when: (types) => types.has("text") || types.has("frame") || types.has("instance"),
    fields: [
      { property: "font-family", kind: "font" },
      { property: "font-size", kind: "text" },
      { property: "font-weight", options: ["400", "500", "600", "700"] },
      { property: "line-height" },
      { property: "letter-spacing" },
      { property: "text-align", options: ["start", "center", "end"] },
      { property: "color", kind: "color" },
    ],
  },
  {
    title: "Appearance",
    fields: [
      { property: "background", kind: "color" },
      { property: "border", kind: "color" },
      { property: "border-radius", kind: "radius" },
      { property: "opacity" },
      { property: "overflow", options: ["visible", "hidden", "auto"] },
    ],
  },
  {
    title: "Effects",
    fields: [
      { property: "box-shadow", kind: "shadow" },
      { property: "filter" },
      { property: "backdrop-filter" },
      { property: "mix-blend-mode", options: ["normal", "multiply", "screen", "overlay"] },
      { property: "transform" },
    ],
  },
];

const KNOWN = new Set(GROUPS.flatMap((g) => g.fields.map((f) => f.property)));

const MIXED = Symbol("mixed");

function valueOf(nodes: DesignNode[], property: string): string | typeof MIXED {
  const values = new Set(nodes.map((n) => (n.style?.[property] === undefined ? "" : String(n.style[property]))));
  return values.size > 1 ? MIXED : ([...values][0] ?? "");
}

export function PropertiesPanel() {
  const { selection, model, snapshot, issues } = useEditor();
  const nodes = selection.map((id) => model.nodes[id]).filter((n): n is DesignNode => !!n);

  if (nodes.length === 0) {
    const fileIssues = issues.filter((i) => i.severity === "error").slice(0, 8);
    return (
      <div className="panel panel-right" data-testid="properties-panel">
        <div className="panel-body pad">
          <div className="title-sm">{snapshot?.name}</div>
          <div className="muted small">{Object.keys(snapshot?.files ?? {}).length} design files · {snapshot?.tokens.adapter} · {Object.keys(snapshot?.tokens.tokens ?? {}).length} tokens</div>
          {snapshot?.tokenError && <div className="alert alert-warn">{snapshot.tokenError}</div>}
          <div className="section-title">Problems</div>
          {fileIssues.length === 0 ? (
            <p className="muted small">No validation errors.</p>
          ) : (
            fileIssues.map((issue, i) => (
              <button key={i} className="problem" onClick={() => issue.nodeId && model.nodes[issue.nodeId] && useEditor.getState().select([issue.nodeId])}>
                <span className="mono small">{issue.nodeId ?? issue.file}</span>
                <span>{issue.message}</span>
                {issue.fix && <span className="muted small">fix: {issue.fix}</span>}
              </button>
            ))
          )}
          <p className="muted small hint">Select a layer to edit its CSS. Your agent sees the selection via <code>lamsa selection</code>.</p>
        </div>
      </div>
    );
  }

  return <SelectionProperties ids={selection} nodes={nodes} />;
}

function SelectionProperties({ ids, nodes }: { ids: string[]; nodes: DesignNode[] }) {
  const { model, commit, snapshot } = useEditor();
  const types = new Set(nodes.map((n) => n.type));
  const single = nodes.length === 1 ? nodes[0]! : undefined;
  const singleId = single ? ids[0]! : undefined;
  const [adding, setAdding] = useState("");
  const tokens = snapshot?.tokens.tokens ?? {};

  const extra = useMemo(() => {
    const props = new Set<string>();
    for (const node of nodes) for (const key of Object.keys(node.style ?? {})) if (!KNOWN.has(key)) props.add(key);
    return [...props].sort();
  }, [nodes]);

  const write = (property: string, raw: string) => void commit(`Set ${property}`, setStyle(model, ids, { [property]: parseStyleInput(raw) }));

  return (
    <div className="panel panel-right" data-testid="properties-panel">
      <div className="panel-body">
        <div className="props-header">
          {single && singleId ? (
            <>
              <CommitInput
                className="name-input"
                value={single.name ?? ""}
                placeholder={nodeTitle(singleId, single)}
                onCommit={(v) => void commit("Rename", patchNodes(model, ids, (n) => ({ ...n, name: v || undefined }) as DesignNode))}
              />
              <span className="badge">{single.type === "frame" && single.component ? "component" : single.type}</span>
              <div className="muted mono small id-row">
                id {singleId}
                <button className="icon-btn tiny" onClick={() => void navigator.clipboard.writeText(singleId)} aria-label="Copy node ID">
                  <Copy size={12} />
                </button>
              </div>
            </>
          ) : (
            <>
              <span className="title-sm">{nodes.length} layers</span>
              <span className="muted small">Edits apply to all {nodes.length}</span>
            </>
          )}
        </div>

        {single?.type === "instance" && singleId && <InstanceSection id={singleId} node={single} />}
        {single?.type === "text" && singleId && (
          <Section title="Content">
            <textarea
              key={`${singleId}:${single.content}`}
              className="input textarea"
              defaultValue={single.content}
              onBlur={(e) => {
                if (e.target.value !== single.content) void commit("Edit text", patchNodes(model, ids, (n) => ({ ...n, content: e.target.value }) as DesignNode));
              }}
            />
          </Section>
        )}
        {single?.type === "icon" && (
          <Section title="Icon">
            <Field label="icon" value={single.icon} onCommit={(v) => void commit("Set icon", patchNodes(model, ids, (n) => ({ ...n, icon: v }) as DesignNode))} />
            <div className="muted small">lucide icon name, e.g. lock, chevron-right</div>
          </Section>
        )}
        {single?.type === "image" && (
          <Section title="Image">
            <Field label="src" value={single.src} onCommit={(v) => void commit("Set src", patchNodes(model, ids, (n) => ({ ...n, src: v }) as DesignNode))} />
            <Field label="alt" value={single.alt ?? ""} onCommit={(v) => void commit("Set alt", patchNodes(model, ids, (n) => ({ ...n, alt: v }) as DesignNode))} />
          </Section>
        )}
        {single?.type === "frame" && single.parentId === undefined && (
          <Section title="Canvas">
            <div className="field-grid">
              <Field label="x" value={String(single.x ?? 0)} onCommit={(v) => void commit("Move", patchNodes(model, ids, (n) => ({ ...n, x: Number(v) || 0 }) as DesignNode))} />
              <Field label="y" value={String(single.y ?? 0)} onCommit={(v) => void commit("Move", patchNodes(model, ids, (n) => ({ ...n, y: Number(v) || 0 }) as DesignNode))} />
            </div>
            <div className="field">
              <span className="field-label">mode</span>
              <div className="segmented small">
                {(["inherit", "light", "dark"] as const).map((mode) => (
                  <button
                    key={mode}
                    className={(single.mode ?? "inherit") === mode ? "is-on" : ""}
                    onClick={() => void commit("Set mode", patchNodes(model, ids, (n) => ({ ...n, mode: mode === "inherit" ? undefined : mode }) as DesignNode))}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>
          </Section>
        )}

        {GROUPS.filter((g) => !g.when || g.when(types)).map((group) => (
          <Section key={group.title} title={group.title} collapsible>
            {group.fields.map((field) => {
              const value = valueOf(nodes, field.property);
              return (
                <Field
                  key={field.property}
                  label={field.property}
                  value={value === MIXED ? "" : value}
                  mixed={value === MIXED}
                  options={field.options}
                  tokens={tokens}
                  kind={field.kind}
                  onCommit={(v) => write(field.property, v)}
                />
              );
            })}
          </Section>
        ))}

        <Section title="Other CSS">
          {extra.map((property) => {
            const value = valueOf(nodes, property);
            return (
              <Field
                key={property}
                label={property}
                value={value === MIXED ? "" : value}
                mixed={value === MIXED}
                tokens={tokens}
                onCommit={(v) => write(property, v)}
                onRemove={() => write(property, "")}
              />
            );
          })}
          <form
            className="add-prop"
            onSubmit={(e) => {
              e.preventDefault();
              const [property, ...rest] = adding.split(":");
              if (!property?.trim()) return;
              write(property.trim(), rest.join(":").trim() || "initial");
              setAdding("");
            }}
          >
            <Plus size={14} />
            <input className="input" placeholder="property: value" value={adding} onChange={(e) => setAdding(e.target.value)} />
          </form>
        </Section>
      </div>
    </div>
  );
}

function InstanceSection({ id, node }: { id: string; node: Extract<DesignNode, { type: "instance" }> }) {
  const { model, commit, select } = useEditor();
  const component = model.nodes[node.componentId];
  const definitions = component?.type === "frame" ? (component.component?.props ?? {}) : {};
  const setProp = (name: string, value: string | boolean) =>
    void commit(`Set ${name}`, patchNodes(model, [id], (n) => ({ ...n, props: { ...(n as typeof node).props, [name]: value } }) as DesignNode));
  const overrides = Object.keys(node.overrides ?? {});
  return (
    <Section title="Component">
      <div className="instance-head">
        <Component size={14} className="accent" />
        <span>{nodeTitle(node.componentId, component)}</span>
      </div>
      <div className="row-actions">
        <button
          className="btn small"
          onClick={() => {
            select([node.componentId]);
            requestAnimationFrame(() => fitTo("selection"));
          }}
        >
          <Target size={14} /> Go to main
        </button>
        <button className="btn small" onClick={() => void commit("Detach instance", detachInstance(model, id))}>
          <Unlink size={14} /> Detach
        </button>
      </div>
      {Object.entries(definitions).map(([name, def]) => (
        <div className="field" key={name}>
          <span className="field-label">{name}</span>
          {def.type === "enum" ? (
            <div className="segmented small wrap">
              {def.options.map((option) => (
                <button key={option} className={(node.props?.[name] ?? def.default) === option ? "is-on" : ""} onClick={() => setProp(name, option)}>
                  {option}
                </button>
              ))}
            </div>
          ) : def.type === "boolean" ? (
            <input type="checkbox" checked={Boolean(node.props?.[name] ?? def.default)} onChange={(e) => setProp(name, e.target.checked)} />
          ) : (
            <CommitInput className="input" value={String(node.props?.[name] ?? def.default)} onCommit={(v) => setProp(name, v)} />
          )}
        </div>
      ))}
      {overrides.length > 0 && (
        <div className="overrides">
          <div className="overline">Overrides</div>
          {overrides.map((inner) => (
            <div key={inner} className="override-row">
              <span className="mono small">{nodeTitle(inner, model.nodes[inner])}</span>
              <button
                className="icon-btn tiny"
                aria-label="Reset override"
                onClick={() =>
                  void commit(
                    "Reset override",
                    patchNodes(model, [id], (n) => {
                      const rest = { ...(n as typeof node).overrides };
                      delete rest[inner];
                      return { ...n, overrides: Object.keys(rest).length ? rest : undefined } as DesignNode;
                    }),
                  )
                }
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function Section({ title, children, collapsible }: { title: string; children: React.ReactNode; collapsible?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="section">
      <button className="section-title" onClick={() => collapsible && setOpen(!open)}>
        {title}
        {collapsible && <ChevronDown size={14} className={open ? "" : "rot"} />}
      </button>
      {open && <div className="section-body">{children}</div>}
    </div>
  );
}

function CommitInput({ value, onCommit, className, placeholder, list }: { value: string; onCommit: (v: string) => void; className?: string; placeholder?: string; list?: string }) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  return (
    <input
      className={className}
      value={draft}
      placeholder={placeholder}
      list={list}
      onFocus={() => (focused.current = true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        focused.current = false;
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(value);
          focused.current = false;
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function Field({
  label,
  value,
  mixed,
  options,
  tokens,
  kind,
  onCommit,
  onRemove,
}: {
  label: string;
  value: string;
  mixed?: boolean;
  options?: string[];
  tokens?: Record<string, Token>;
  kind?: TokenKind;
  onCommit: (value: string) => void;
  onRemove?: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const isToken = /\{[^}]+\}/.test(value);
  const listId = options ? `opts-${label}` : undefined;
  const swatch = isToken && tokens ? tokens[value.slice(1, -1)] : undefined;
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className={`field-control ${isToken ? "is-token" : ""}`}>
        {swatch?.kind === "color" && <span className="swatch" style={{ background: swatch.values.light }} />}
        <CommitInput className="input mono" value={value} placeholder={mixed ? "Mixed" : ""} list={listId} onCommit={onCommit} />
        {options && (
          <datalist id={listId}>
            {options.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        )}
        {tokens && (
          <button className="icon-btn tiny" onClick={() => setPicking(!picking)} aria-label={`Pick a token for ${label}`}>
            <Braces size={12} />
          </button>
        )}
        {onRemove && (
          <button className="icon-btn tiny" onClick={onRemove} aria-label={`Remove ${label}`}>
            <X size={12} />
          </button>
        )}
      </div>
      {picking && tokens && (
        <TokenPicker
          tokens={tokens}
          kind={kind}
          onPick={(path) => {
            setPicking(false);
            onCommit(label === "border" ? `1px solid {${path}}` : `{${path}}`);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

function TokenPicker({ tokens, kind, onPick, onClose }: { tokens: Record<string, Token>; kind?: TokenKind; onPick: (path: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(!kind);
  const list = Object.values(tokens)
    .filter((t) => (showAll || t.kind === kind) && t.path.includes(query))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  return (
    <div className="token-picker" data-testid="token-picker" onMouseLeave={onClose}>
      <input className="input" autoFocus placeholder="Search tokens" value={query} onChange={(e) => setQuery(e.target.value)} />
      {kind && (
        <label className="muted small check">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> all kinds
        </label>
      )}
      <div className="token-list">
        {list.map((token) => (
          <button key={token.path} className="menu-item" onClick={() => onPick(token.path)}>
            {token.kind === "color" && <span className="swatch" style={{ background: token.values.light }} />}
            <span className="mono">{`{${token.path}}`}</span>
            <span className="muted small grow-right">{token.values.light}</span>
          </button>
        ))}
        {list.length === 0 && <p className="muted small pad">No tokens{kind ? ` of kind ${kind}` : ""}.</p>}
      </div>
      <div className="muted small pad">Read-only, from {useEditor.getState().snapshot?.tokens.source ?? "your app's CSS"}</div>
    </div>
  );
}
