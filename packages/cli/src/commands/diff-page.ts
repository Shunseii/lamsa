import type { DesignDiff, NodeChange, ValueChange } from "@lamsa/core";
import type { ScreenReport } from "./diff.js";

interface PageInput {
  diff: DesignDiff;
  screens: ScreenReport[];
  colors: { added: string; removed: string; changed: string };
  names: (id: unknown) => string;
  describe: (input: { value: ValueChange; names: (id: unknown) => string }) => string;
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const layerName = (change: NodeChange) => change.name ?? (change.text !== undefined ? JSON.stringify(change.text) : `${change.type} ${change.id}`);

function detail({ change, input }: { change: NodeChange; input: PageInput }): string {
  if (change.kind !== "changed") return change.type;
  return change.values!.map((value) => input.describe({ value, names: input.names })).join(" · ");
}

/** Changes worth listing under a screen: its layers, plus the screen frame itself when it changed. */
const listed = (screen: ScreenReport) => screen.changes.filter((change) => change.id !== screen.id || change.kind === "changed");

const groups = (screens: ScreenReport[]) => ({
  changed: screens.filter((screen) => screen.kind === "changed" && screen.visible !== false),
  invisible: screens.filter((screen) => screen.kind === "changed" && screen.visible === false),
  added: screens.filter((screen) => screen.kind === "added"),
  removed: screens.filter((screen) => screen.kind === "removed"),
});

function summaryLine({ diff, screens }: PageInput): string {
  const { changed, invisible, added, removed } = groups(screens);
  return [
    `${changed.length} changed`,
    added.length ? `${added.length} new` : "",
    removed.length ? `${removed.length} removed` : "",
    invisible.length ? `${invisible.length} with no visible change` : "",
    diff.repositioned.length ? `${diff.repositioned.length} moved on the canvas` : "",
  ]
    .filter(Boolean)
    .join(" · ")
    .concat(` · ${diff.changes.length} layer change${diff.changes.length === 1 ? "" : "s"}`);
}

export function diffPage(input: PageInput): string {
  const { diff, screens, colors } = input;
  const { changed, invisible, added, removed } = groups(screens);
  const symbol = { added: "+", removed: "−", changed: "~" } as const;

  const changeRows = (screen: ScreenReport) =>
    listed(screen)
      .map(
        (change) =>
          `<li class="${change.kind}"><span class="sym">${symbol[change.kind]}</span><b>${escapeHtml(layerName(change))}</b><span>${escapeHtml(detail({ change, input }))}</span></li>`,
      )
      .join("");

  const card = (screen: ScreenReport) => `
<section class="card" id="${escapeHtml(screen.id)}">
  <header>
    <h3>${escapeHtml(screen.name ?? screen.id)}</h3>
    <span class="meta">${escapeHtml(screen.file)} · <code>${escapeHtml(screen.id)}</code>${screen.components.length ? ` · via ${screen.components.map((id) => escapeHtml(input.names(id))).join(", ")}` : ""}</span>
    <div class="views">
      <button class="on" data-view="side">Side by side</button><button data-view="slider">Slider</button>
      <label><input type="checkbox" checked data-outlines> Outlines</label>
    </div>
  </header>
  <div class="side">
    <figure><figcaption>Before</figcaption>${image(screen, "before")}</figure>
    <figure><figcaption>After</figcaption>${image(screen, "after")}</figure>
  </div>
  <div class="slider" hidden>
    <div class="stack">${image(screen, "before")}<div class="top">${image(screen, "after")}</div></div>
    <input type="range" min="0" max="100" value="50" aria-label="Before / after">
  </div>
  <ul class="changes">${changeRows(screen)}</ul>
</section>`;

  const tile = (screen: ScreenReport, side: "before" | "after") => `
<figure class="tile"><div class="thumb">${image(screen, side)}</div><figcaption>${escapeHtml(screen.name ?? screen.id)}<span>${escapeHtml(screen.file)}</span></figcaption></figure>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Design changes · ${escapeHtml(diff.base)} → ${escapeHtml(diff.head)}</title>
<style>
:root { --bg:#f6f5f1; --card:#fff; --ink:#1b1a17; --ink2:#65635c; --line:#e3e0d8; --checker:#eeece6;
  --added:${colors.added}; --removed:${colors.removed}; --changed:${colors.changed}; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg:#151513; --card:#1e1e1b; --ink:#eceae4; --ink2:#a19e95; --line:#34332f; --checker:#262622; color-scheme: dark; } }
* { box-sizing: border-box; } [hidden] { display:none !important; }
body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width:1280px; margin:0 auto; padding:32px 24px 64px; }
h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:15px; margin:40px 0 12px; color:var(--ink2); font-weight:600; }
.sub { color:var(--ink2); margin:0; } code { font:12px ui-monospace, monospace; }
.legend { display:flex; gap:16px; margin-top:12px; color:var(--ink2); font-size:13px; flex-wrap:wrap; }
.legend span::before { content:""; display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:6px; vertical-align:-1px; border:2px solid var(--c); background:color-mix(in srgb, var(--c) 15%, transparent); }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin-bottom:20px; }
.card header { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; margin-bottom:12px; }
.card h3 { margin:0; font-size:16px; } .meta { color:var(--ink2); font-size:12px; }
.views { margin-left:auto; display:flex; gap:4px; align-items:center; }
.views button { font:inherit; font-size:12px; border:1px solid var(--line); background:transparent; color:var(--ink2); padding:3px 10px; border-radius:6px; cursor:pointer; }
.views button.on { background:var(--ink); color:var(--card); border-color:var(--ink); }
.views label { font-size:12px; color:var(--ink2); margin-left:8px; display:flex; gap:4px; align-items:center; }
.side { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
figure { margin:0; min-width:0; } figcaption { font-size:12px; color:var(--ink2); margin-bottom:6px; }
.side img, .stack img { display:block; max-width:100%; min-width:0; height:auto; }
.tile img { width:auto !important; }
.frame { background:repeating-conic-gradient(var(--checker) 0 25%, transparent 0 50%) 0 0/16px 16px; border-radius:6px; padding:8px; display:flex; justify-content:center; align-items:flex-start; justify-content:flex-start; min-width:0; overflow:hidden; }
.frame img.plain { display:none; } .no-outlines .frame img.plain { display:block; } .no-outlines .frame img.marked { display:none; }
.slider .stack { position:relative; max-width:900px; margin:0 auto; } .slider .stack .frame { padding:0; }
.slider .top { position:absolute; inset:0; clip-path:inset(0 0 0 var(--split, 50%)); }
.slider .top::before { content:""; position:absolute; top:0; bottom:0; left:var(--split, 50%); width:2px; background:var(--ink); z-index:1; }
.slider input { display:block; width:100%; max-width:900px; margin:10px auto 0; }
.changes { list-style:none; margin:14px 0 0; padding:12px 0 0; border-top:1px solid var(--line); display:grid; gap:4px; font-size:13px; }
.changes li { display:flex; gap:8px; align-items:baseline; } .changes li span:last-child { color:var(--ink2); overflow-wrap:anywhere; }
.sym { width:14px; text-align:center; font-weight:700; } .added .sym { color:var(--added); } .removed .sym { color:var(--removed); } .changed .sym { color:var(--changed); }
.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:16px; }
.tile { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px; }
.tile .thumb { height:180px; display:flex; align-items:center; justify-content:center; overflow:hidden; background:repeating-conic-gradient(var(--checker) 0 25%, transparent 0 50%) 0 0/16px 16px; border-radius:6px; }
.tile img { max-width:100%; max-height:100%; } .tile figcaption { margin:8px 0 0; color:var(--ink); font-size:13px; display:flex; flex-direction:column; }
.tile figcaption span { color:var(--ink2); font-size:11px; } .tile.removed-tile img { opacity:.6; }
details { margin-top:8px; } summary { cursor:pointer; color:var(--ink2); }
table { border-collapse:collapse; width:100%; font-size:12px; margin-top:8px; } td, th { border-bottom:1px solid var(--line); padding:4px 8px; text-align:left; vertical-align:top; }
@media (max-width:720px) { .side { grid-template-columns:1fr; } .views { margin-left:0; } }
</style></head>
<body><main>
<h1>Design changes</h1>
<p class="sub"><code>${escapeHtml(diff.base)}</code> → <code>${escapeHtml(diff.head)}</code> · ${escapeHtml(summaryLine(input))}</p>
<div class="legend"><span style="--c:var(--added)">New layer</span><span style="--c:var(--changed)">Changed layer</span><span style="--c:var(--removed)">Removed layer</span></div>
${changed.length ? `<h2>Changed screens</h2>${changed.map(card).join("")}` : diff.changes.length ? "" : "<p>No design changes.</p>"}
${added.length ? `<h2>New screens</h2><div class="grid">${added.map((screen) => tile(screen, "after")).join("")}</div>` : ""}
${removed.length ? `<h2>Removed screens</h2><div class="grid">${removed.map((screen) => tile(screen, "before").replace('class="tile"', 'class="tile removed-tile"')).join("")}</div>` : ""}
${invisible.length ? `<h2>No visible change</h2><p class="sub">These screens changed in the file, but render the same.</p>${invisible.map((screen) => `<details><summary>${escapeHtml(screen.name ?? screen.id)} <span class="meta">${escapeHtml(screen.file)}</span></summary><ul class="changes">${changeRows(screen)}</ul></details>`).join("")}` : ""}
<h2>All layer changes</h2>
<details><summary>${diff.changes.length} layer change${diff.changes.length === 1 ? "" : "s"}</summary><table><tr><th></th><th>Layer</th><th>File</th><th>Change</th></tr>
${diff.changes.map((change) => `<tr class="${change.kind}"><td class="sym">${symbol[change.kind]}</td><td>${escapeHtml(layerName(change))} <code>${escapeHtml(change.id)}</code></td><td>${escapeHtml(change.file)}</td><td>${escapeHtml(detail({ change, input }))}</td></tr>`).join("\n")}
</table></details>
</main>
<script>
for (const card of document.querySelectorAll(".card")) {
  const side = card.querySelector(".side"), slider = card.querySelector(".slider");
  for (const button of card.querySelectorAll("[data-view]")) button.addEventListener("click", () => {
    for (const other of card.querySelectorAll("[data-view]")) other.classList.toggle("on", other === button);
    side.hidden = button.dataset.view !== "side"; slider.hidden = button.dataset.view !== "slider";
  });
  card.querySelector("[data-outlines]").addEventListener("change", (event) => card.classList.toggle("no-outlines", !event.target.checked));
  const range = slider.querySelector("input");
  range.addEventListener("input", () => slider.style.setProperty("--split", range.value + "%"));
}
</script>
</body></html>
`;
}

function image(screen: ScreenReport, side: "before" | "after"): string {
  const plain = side === "before" ? screen.before : screen.after;
  const marked = side === "before" ? screen.beforeMarked : screen.afterMarked;
  if (!plain) return `<div class="frame"><span class="meta">${side === "before" ? "new" : "removed"}</span></div>`;
  // Both sides share one scale: the wider render fills its column and the other keeps its size relative to it.
  const size = side === "before" ? screen.beforeSize : screen.afterSize;
  const widest = Math.max(screen.beforeSize?.width ?? 0, screen.afterSize?.width ?? 0);
  const style = size && widest ? ` style="width:${((size.width / widest) * 100).toFixed(2)}%"` : "";
  const alt = `${screen.name ?? screen.id}, ${side}`;
  if (!marked) return `<div class="frame"><img src="${escapeHtml(plain)}"${style} alt="${escapeHtml(alt)}"></div>`;
  return `<div class="frame"><img class="marked" src="${escapeHtml(marked)}"${style} alt="${escapeHtml(alt)}, changes outlined"><img class="plain" src="${escapeHtml(plain)}"${style} alt="${escapeHtml(alt)}"></div>`;
}

export function diffMarkdown(input: PageInput & { imageBaseUrl?: string }): string {
  const { diff, screens, imageBaseUrl } = input;
  const { changed, invisible, added, removed } = groups(screens);
  const url = (file: string) => (imageBaseUrl ? `${imageBaseUrl.replace(/\/$/, "")}/${file}` : file);
  const img = (file: string | undefined, width: number) => (file ? `<img src="${url(file)}" width="${width}">` : "");
  const square = { added: "🟩", removed: "🟥", changed: "🟧" } as const;
  const lines = ["<!-- lamsa-diff -->", "## lamsa design changes", ""];
  if (diff.changes.length === 0) {
    lines.push(`No design changes since \`${diff.base}\`.`);
  } else {
    lines.push(`${summaryLine(input)} since \`${diff.base}\`.`, "", "🟩 new layer · 🟧 changed layer · 🟥 removed layer", "");
    for (const screen of changed) {
      lines.push(`### ${screen.name ?? screen.id}`, "", `<sub>${screen.file} · \`${screen.id}\`${screen.components.length ? ` · via ${screen.components.map(input.names).join(", ")}` : ""}</sub>`, "");
      lines.push("| Before | After |", "|---|---|", `| ${img(screen.beforeMarked ?? screen.before, 400)} | ${img(screen.afterMarked ?? screen.after, 400)} |`, "");
      for (const change of listed(screen)) lines.push(`- ${square[change.kind]} **${layerName(change)}** ${detail({ change, input })}`);
      lines.push("");
    }
    const tiles = (list: typeof screens, side: "before" | "after") => {
      const rows: string[] = ["| | | |", "|---|---|---|"];
      for (let i = 0; i < list.length; i += 3) {
        const row = list.slice(i, i + 3);
        rows.push(`| ${[0, 1, 2].map((n) => (row[n] ? `${img(side === "before" ? row[n]!.before : row[n]!.after, 240)}<br>**${row[n]!.name ?? row[n]!.id}**` : "")).join(" | ")} |`);
      }
      return rows;
    };
    if (added.length) lines.push(`### New screens (${added.length})`, "", ...tiles(added, "after"), "");
    if (removed.length) lines.push(`### Removed screens (${removed.length})`, "", ...tiles(removed, "before"), "");
    if (invisible.length) lines.push(`<sub>No visible change: ${invisible.map((screen) => screen.name ?? screen.id).join(", ")}</sub>`, "");
    lines.push("<details><summary>All layer changes</summary>", "", "| | Layer | File | Change |", "|---|---|---|---|");
    for (const change of diff.changes) {
      lines.push(`| ${square[change.kind]} | ${layerName(change)} \`${change.id}\` | ${change.file} | ${detail({ change, input }).replace(/\|/g, "\\|")} |`);
    }
    lines.push("", "</details>");
  }
  lines.push("", "<sub>Made by `lamsa diff`. Designs are specs; the agent implements them in code.</sub>", "");
  return lines.join("\n");
}
