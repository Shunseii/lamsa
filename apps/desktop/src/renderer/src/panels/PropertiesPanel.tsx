import type { DesignNode, Token, TokenKind } from "@lamsa/schema";
import { Braces, Check, ChevronDown, Component, Copy, Plus, Target, Unlink, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { detachInstance, parseStyleInput, patchNodes, setStyle } from "../lib/edits";
import { nodeTitle } from "../lib/model";
import { useEditor } from "../lib/store";
import { fitTo } from "../lib/viewport";
import { AutocompleteInput, type Suggestion } from "./AutocompleteInput";
import { IconField } from "./IconField";
import { Popover } from "./Popover";

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

const CSS_PROPERTIES = [
  ...KNOWN,
  ...["min-width", "max-width", "min-height", "max-height", "aspect-ratio", "top", "right", "bottom", "left", "inset", "z-index"],
  ...["flex-wrap", "flex-grow", "flex-shrink", "flex-basis", "align-self", "align-content", "justify-self", "justify-items", "order"],
  ...["grid-template-columns", "grid-template-rows", "grid-column", "grid-row", "row-gap", "column-gap"],
  ...["padding-top", "padding-right", "padding-bottom", "padding-left", "padding-inline", "padding-block"],
  ...["margin-top", "margin-right", "margin-bottom", "margin-left", "margin-inline", "margin-block"],
  ...["border-top", "border-right", "border-bottom", "border-left", "border-color", "border-width", "border-style", "outline", "outline-offset"],
  ...["font-style", "text-transform", "text-decoration", "text-overflow", "white-space", "word-break", "text-wrap"],
  ...["object-fit", "object-position", "background-image", "background-size", "background-position", "visibility", "cursor"],
].filter((property, i, all) => all.indexOf(property) === i);

/** Token completions for the `{…` being typed (or a bare word), keeping whatever comes before it. */
function tokenSuggestions(draft: string, tokens: Record<string, Token> | undefined, kind?: TokenKind): Suggestion[] {
  if (!tokens) return [];
  const brace = draft.lastIndexOf("{");
  let prefix: string;
  let query: string;
  if (brace !== -1 && !draft.slice(brace).includes("}")) {
    prefix = draft.slice(0, brace);
    query = draft.slice(brace + 1);
  } else if (/^[a-z][\w.-]*$/i.test(draft)) {
    prefix = "";
    query = draft;
  } else {
    return [];
  }
  const q = query.toLowerCase();
  const rank = (t: Token) => (kind && t.kind !== kind ? 2 : 0) + (t.path.toLowerCase().startsWith(q) || t.path.toLowerCase().includes(`.${q}`) ? 0 : 1);
  return Object.values(tokens)
    .filter((t) => t.path.toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path, undefined, { numeric: true }))
    .map((t) => ({
      key: t.path,
      label: `{${t.path}}`,
      detail: t.values.light,
      swatch: t.kind === "color" ? t.values.light : undefined,
      apply: `${prefix}{${t.path}}`,
    }));
}

function optionSuggestions(draft: string, options: string[]): Suggestion[] {
  const q = draft.trim().toLowerCase();
  return options
    .filter((o) => o.toLowerCase().includes(q) && o !== draft)
    .sort((a, b) => Number(!a.startsWith(q)) - Number(!b.startsWith(q)))
    .map((o) => ({ key: o, label: o, apply: o }));
}

function declarationSuggestions(draft: string, tokens: Record<string, Token> | undefined): Suggestion[] {
  const colon = draft.indexOf(":");
  if (colon === -1) {
    const q = draft.trim().toLowerCase();
    if (!q) return [];
    return CSS_PROPERTIES.filter((p) => p.includes(q))
      .sort((a, b) => Number(!a.startsWith(q)) - Number(!b.startsWith(q)) || a.length - b.length)
      .map((p) => ({ key: p, label: p, apply: `${p}: `, keepEditing: true }));
  }
  const head = draft.slice(0, colon + 1);
  const valuePart = draft.slice(colon + 1).trimStart();
  return tokenSuggestions(valuePart, tokens).map((s) => ({ ...s, apply: `${head} ${s.apply}` }));
}

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
  const addProp = useRef<HTMLDivElement>(null);
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
                <CopyButton text={singleId} label="Copy node ID" />
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
        {single?.type === "frame" && single.component && singleId && <MainComponentSection id={singleId} node={single} />}
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
            <IconField value={single.icon} onCommit={(v) => void commit("Set icon", patchNodes(model, ids, (n) => ({ ...n, icon: v }) as DesignNode))} />
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
          <div className="add-prop" ref={addProp}>
            <Plus size={14} />
            <AutocompleteInput
              className="input mono"
              placeholder="property: value"
              value=""
              testId="add-property"
              anchor={() => addProp.current}
              suggest={(draft) => declarationSuggestions(draft, tokens)}
              commitOnBlur={false}
              clearOnCommit
              onCommit={(declaration) => {
                const [property, ...rest] = declaration.split(":");
                if (!property?.trim()) return;
                write(property.trim(), rest.join(":").trim() || "initial");
              }}
            />
          </div>
        </Section>
      </div>
    </div>
  );
}

function MainComponentSection({ id, node }: { id: string; node: Extract<DesignNode, { type: "frame" }> }) {
  const { model, commit, previewProps, setPreviewProp } = useEditor();
  const definitions = node.component?.props ?? {};
  const preview = previewProps[id] ?? {};
  const instances = Object.values(model.nodes).filter((n) => n.type === "instance" && n.componentId === id).length;
  const setDefault = (name: string, value: string | boolean) => {
    void commit(
      `Set ${name} default`,
      patchNodes(model, [id], (n) => {
        const frame = structuredClone(n) as typeof node;
        const def = frame.component!.props![name]!;
        (def as { default: string | boolean }).default = value;
        return frame;
      }),
    );
    setPreviewProp(id, name, undefined);
  };
  const names = Object.keys(definitions);
  return (
    <Section title="Component">
      <div className="muted small">
        Main component · {instances} instance{instances === 1 ? "" : "s"}
        {names.length > 0 && " · preview a variant here; it isn't saved"}
      </div>
      {names.length === 0 && <div className="muted small">No props. Your agent can add variants and props to the component JSON.</div>}
      {Object.entries(definitions).map(([name, def]) => {
        if (def.type === "text") {
          return (
            <div className="field" key={name}>
              <span className="field-label">{name}</span>
              <CommitInput className="input" value={def.default} onCommit={(v) => setDefault(name, v)} />
            </div>
          );
        }
        const options: (string | boolean)[] = def.type === "enum" ? def.options : [false, true];
        const shown = preview[name] ?? def.default;
        return (
          <div className="field" key={name}>
            <span className="field-label">{name}</span>
            <div className="variant-control">
              <div className="segmented small wrap" role="group" aria-label={`${name} variant`}>
                {options.map((option) => (
                  <button
                    key={String(option)}
                    className={shown === option ? "is-on" : ""}
                    title={option === def.default ? "Default" : undefined}
                    onClick={() => setPreviewProp(id, name, option === def.default ? undefined : option)}
                  >
                    {String(option)}
                    {option === def.default && <span className="default-dot" aria-label="default" />}
                  </button>
                ))}
              </div>
              {shown !== def.default && (
                <button className="link small" onClick={() => setDefault(name, shown)}>
                  Make default
                </button>
              )}
            </div>
          </div>
        );
      })}
    </Section>
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

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => setCopied(false), [text]);
  return (
    <button
      className={`icon-btn tiny ${copied ? "is-copied" : ""}`}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
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

function CommitInput({
  value,
  onCommit,
  className,
  placeholder,
  onArrowDown,
}: {
  value: string;
  onCommit: (v: string) => void;
  className?: string;
  placeholder?: string;
  onArrowDown?: () => void;
}) {
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
      onFocus={() => (focused.current = true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        focused.current = false;
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "ArrowDown" && onArrowDown) {
          e.preventDefault();
          onArrowDown();
        }
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
  const [menu, setMenu] = useState<"options" | "tokens" | null>(null);
  const control = useRef<HTMLDivElement>(null);
  const isToken = /\{[^}]+\}/.test(value);
  const swatch = isToken && tokens ? tokens[value.slice(1, -1)] : undefined;
  const toggle = (next: "options" | "tokens") => setMenu((current) => (current === next ? null : next));
  const close = useCallback(() => setMenu(null), []);
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div ref={control} className={`field-control ${isToken ? "is-token" : ""} ${menu ? "is-open" : ""}`}>
        {swatch?.kind === "color" && <span className="swatch" style={{ background: swatch.values.light }} />}
        <AutocompleteInput
          className="input mono"
          value={value}
          placeholder={mixed ? "Mixed" : ""}
          anchor={() => control.current}
          suggest={(draft) => (options ? optionSuggestions(draft, options) : tokenSuggestions(draft, tokens, kind))}
          onCommit={onCommit}
          onArrowDownWhenClosed={() => setMenu(options ? "options" : tokens ? "tokens" : null)}
        />
        {options ? (
          <button className="icon-btn tiny" onClick={() => toggle("options")} aria-label={`Choose ${label}`}>
            <ChevronDown size={12} />
          </button>
        ) : (
          tokens && (
            <button className="icon-btn tiny" onClick={() => toggle("tokens")} aria-label={`Pick a token for ${label}`}>
              <Braces size={12} />
            </button>
          )
        )}
        {onRemove && (
          <button className="icon-btn tiny" onClick={onRemove} aria-label={`Remove ${label}`}>
            <X size={12} />
          </button>
        )}
      </div>
      {menu === "options" && options && (
        <Popover anchor={control.current} width={Math.max(160, control.current?.offsetWidth ?? 0)} onClose={close} testId="options-menu">
          <div className="popover-list">
            {options.map((option) => (
              <button
                key={option}
                className={`menu-item ${option === value ? "is-active" : ""}`}
                onClick={() => {
                  setMenu(null);
                  if (option !== value) onCommit(option);
                }}
              >
                <span className="mono">{option}</span>
                {option === value && <Check size={12} className="accent push-right" />}
              </button>
            ))}
          </div>
        </Popover>
      )}
      {menu === "tokens" && tokens && (
        <Popover anchor={control.current} width={320} onClose={close} testId="token-picker">
          <TokenPicker
            tokens={tokens}
            kind={kind}
            current={isToken ? value.slice(1, -1) : undefined}
            onPick={(path) => {
              setMenu(null);
              onCommit(label === "border" ? `1px solid {${path}}` : `{${path}}`);
            }}
          />
        </Popover>
      )}
    </div>
  );
}

function TokenPicker({ tokens, kind, current, onPick }: { tokens: Record<string, Token>; kind?: TokenKind; current?: string; onPick: (path: string) => void }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = Object.values(tokens)
    .filter((t) => t.path.toLowerCase().includes(q))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  const suggested = kind ? matches.filter((t) => t.kind === kind) : matches;
  const others = kind ? matches.filter((t) => t.kind !== kind) : [];
  const row = (token: Token) => (
    <button key={token.path} className={`menu-item ${token.path === current ? "is-active" : ""}`} title={token.values.light} onClick={() => onPick(token.path)}>
      {token.kind === "color" && <span className="swatch" style={{ background: token.values.light }} />}
      <span className="mono">{`{${token.path}}`}</span>
      <span className="muted small grow-right">{token.values.light}</span>
    </button>
  );
  return (
    <>
      <input
        className="input"
        autoFocus
        placeholder="Search tokens"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          const first = suggested[0] ?? others[0];
          if (e.key === "Enter" && first) onPick(first.path);
        }}
      />
      <div className="popover-list">
        {suggested.map(row)}
        {others.length > 0 && (
          <>
            <div className="overline">{suggested.length ? "Other tokens" : `No ${kind} tokens match · other tokens`}</div>
            {others.map(row)}
          </>
        )}
        {matches.length === 0 && <p className="muted small pad">No tokens match “{query}”.</p>}
      </div>
      <div className="muted small popover-foot">Read-only, from {useEditor.getState().snapshot?.tokens.source ?? "your app's CSS"}</div>
    </>
  );
}
