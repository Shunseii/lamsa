import { ChevronDown, FolderOpen, House, LayoutDashboard, Palette } from "lucide-react";
import { useRef, useState } from "react";
import type { RecentProject } from "../../../shared/api";
import { shortcut } from "../lib/keys";
import { api, useEditor } from "../lib/store";
import { runCommand } from "../lib/commands";
import { fitTo } from "../lib/viewport";
import { Popover } from "./Popover";

/** Opens another project (picker or a recent one), then fits it in view. */
export async function openAnotherProject(root?: string) {
  if (await useEditor.getState().switchProject(root)) setTimeout(() => fitTo("all"), 120);
}

/** The project name in the top bar: switch projects, or go back to the welcome screen. */
export function ProjectMenu() {
  const name = useEditor((s) => s.snapshot?.name);
  const root = useEditor((s) => s.snapshot?.root);
  const goHome = useEditor((s) => s.goHome);
  const tokens = useEditor((s) => s.snapshot?.tokens);
  const tokenError = useEditor((s) => s.snapshot?.tokenError);
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<RecentProject[]>([]);

  const toggle = () => {
    if (!open) void api().welcome().then((state) => setRecent(state.recent.filter((project) => project.root !== root).slice(0, 6)));
    setOpen((o) => !o);
  };

  return (
    <>
      <button ref={button} className="project-button" onClick={toggle} title={root} data-testid="project-menu">
        <span className="project-name">{name}</span>
        <ChevronDown size={13} className="muted" />
      </button>
      {open && (
        <Popover anchor={button.current} width={280} onClose={() => setOpen(false)} testId="project-menu-list">
          <div className="popover-list">
            <button
              className="menu-item"
              onClick={() => {
                setOpen(false);
                void openAnotherProject();
              }}
            >
              <FolderOpen size={14} className="muted" />
              Open project…
              <kbd>{shortcut("mod+o")}</kbd>
            </button>
            {recent.length > 0 && (
              <>
                <div className="menu-heading">Recent</div>
                {recent.map((project) => (
                  <button
                    key={project.root}
                    className="menu-item"
                    title={project.root}
                    data-root={project.root}
                    onClick={() => {
                      setOpen(false);
                      void openAnotherProject(project.root);
                    }}
                  >
                    <span className="truncate">{project.name}</span>
                    <span className="mono muted small truncate push-right">{project.root.replace(/^\/home\/[^/]+/, "~")}</span>
                  </button>
                ))}
              </>
            )}
            <div className="menu-sep" />
            <button
              className="menu-item"
              data-testid="reset-panel-layout"
              onClick={() => {
                setOpen(false);
                void runCommand("reset-panel-layout");
              }}
            >
              <LayoutDashboard size={14} className="muted" />
              Reset panel layout
              <kbd>{shortcut("mod+alt+0")}</kbd>
            </button>
            <button
              className="menu-item"
              data-testid="go-home"
              onClick={() => {
                setOpen(false);
                void goHome();
              }}
            >
              <House size={14} className="muted" />
              Back to home
            </button>
            {tokens && (
              <>
                <div className="menu-sep" />
                <div className="menu-info" data-testid="project-tokens" title={tokenError}>
                  <Palette size={14} />
                  <span className="menu-info-text">
                    <span className="truncate">
                      {tokenError ? "Tokens failed to load" : `${tokens.adapter} · ${Object.keys(tokens.tokens).length} tokens`}
                    </span>
                    {tokens.source && <span className="mono small truncate">{tokens.source}</span>}
                  </span>
                </div>
              </>
            )}
          </div>
        </Popover>
      )}
    </>
  );
}
