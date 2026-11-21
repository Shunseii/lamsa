import { BookOpen, Check, Copy, FolderOpen, Sparkles, TriangleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { WelcomeState } from "../../../shared/api";
import { api, useEditor } from "../lib/store";
import { LogoMark } from "./LogoMark";

const INIT_COMMAND = "lamsa init --agent claude --yes";

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="code-row">
      <code className="mono">{command}</code>
      <button
        className="icon-btn tiny"
        onClick={() => void navigator.clipboard.writeText(command).then(() => setCopied(true))}
        aria-label={copied ? "Copied" : "Copy command"}
        title={copied ? "Copied" : "Copy"}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

export function Welcome() {
  const [state, setState] = useState<WelcomeState>({ recent: [] });
  const loadSnapshot = useEditor((s) => s.loadSnapshot);

  useEffect(() => {
    void api().welcome().then(setState);
  }, []);

  const open = async (root: string) => {
    // Null when the project is already open in another window, which comes forward instead.
    const snapshot = await api().openProject(root);
    if (snapshot) loadSnapshot(snapshot);
  };

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
            <CopyCommand command={INIT_COMMAND} />
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
            <div key={project.root} className="list-row recent-row">
              <button className="recent-open" onClick={() => void open(project.root)} title={project.root}>
                <FolderOpen size={16} />
                <span className="list-main">
                  <span>{project.name}</span>
                  <span className="muted mono small">{project.root}</span>
                </span>
                <span className="muted small">{new Date(project.openedAt).toLocaleDateString()}</span>
              </button>
              <button
                className="icon-btn tiny recent-remove"
                onClick={() => void api().forgetRecent(project.root).then(setState)}
                aria-label={`Remove ${project.name} from recent projects`}
                title="Remove from recent projects"
              >
                <X size={14} />
              </button>
            </div>
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
            <CopyCommand command={INIT_COMMAND} />
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
