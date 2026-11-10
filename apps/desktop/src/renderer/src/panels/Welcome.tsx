import { BookOpen, Copy, FolderOpen, Sparkles, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import type { WelcomeState } from "../../../shared/api";
import { api, useEditor } from "../lib/store";
import { LogoMark } from "./LogoMark";

export function Welcome() {
  const [state, setState] = useState<WelcomeState>({ recent: [] });
  const loadSnapshot = useEditor((s) => s.loadSnapshot);

  useEffect(() => {
    void api().welcome().then(setState);
  }, []);

  const open = async (root: string) => loadSnapshot(await api().openProject(root));

  const choose = async () => {
    const picked = await api().chooseFolder();
    if (picked.root) await open(picked.root);
    else if (picked.uninitialised) setState((s) => ({ ...s, uninitialised: picked.uninitialised }));
  };

  return (
    <div className="welcome" data-testid="welcome">
      <div className="welcome-top">
        <LogoMark /> <span className="project-name">lamsa</span>
      </div>
      <div className="welcome-main">
        <div className="welcome-intro">
          <h1>
            lamsa <span className="ar">لمسة</span>
          </h1>
          <p>Designs are plain JSON in your repo. Your agent does the bulk through the CLI; you add the touch here.</p>
          <button className="welcome-action" onClick={() => void choose()}>
            <FolderOpen size={16} /> Open folder…
          </button>
          <a className="welcome-action" href="https://github.com/Shunseii/lamsa#readme" target="_blank" rel="noreferrer">
            <BookOpen size={16} /> Read the file format
          </a>
          <div className="welcome-cli">
            <span className="muted small">New repo? Set it up from your terminal, then open it here.</span>
            <code className="mono">npx lamsa init --agent claude --yes</code>
          </div>
        </div>
        <div className="welcome-recent">
          <div className="overline">Recent projects</div>
          {state.recent.length === 0 && (
            <div className="empty-card small">
              <Sparkles size={18} />
              <div className="strong">No projects yet</div>
              <p className="muted small">Open a repo with a lamsa.config.json. Nothing leaves your machine.</p>
            </div>
          )}
          {state.recent.map((project) => (
            <button key={project.root} className="list-row" onClick={() => void open(project.root)}>
              <FolderOpen size={16} />
              <span className="list-main">
                <span>{project.name}</span>
                <span className="muted mono small">{project.root}</span>
              </span>
              <span className="muted small">{new Date(project.openedAt).toLocaleDateString()}</span>
            </button>
          ))}
        </div>
      </div>
      {state.uninitialised && (
        <div className="scrim">
          <div className="dialog">
            <div className="dialog-title">
              <TriangleAlert size={18} /> {state.uninitialised.split("/").pop()} isn't a lamsa project yet
            </div>
            <p className="muted">No lamsa.config.json found. Run this in the repo to create the config, install the agent skill, and add an AGENTS.md section:</p>
            <div className="code-row">
              <code className="mono">npx lamsa init --agent claude --yes</code>
              <button className="icon-btn tiny" onClick={() => void navigator.clipboard.writeText("npx lamsa init --agent claude --yes")} aria-label="Copy command">
                <Copy size={14} />
              </button>
            </div>
            <div className="dialog-actions">
              <button className="btn" onClick={() => void choose()}>
                Choose another folder
              </button>
              <button
                className="btn btn-accent"
                onClick={async () => {
                  try {
                    await open(state.uninitialised!);
                  } catch {
                    useEditor.getState().toast({ tone: "warn", title: "Still no lamsa.config.json", message: "Run the init command in that folder first." });
                  }
                }}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
