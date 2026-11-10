import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { useEditor } from "../lib/store";

const ICONS = { neutral: Info, ok: CircleCheck, warn: TriangleAlert, danger: CircleAlert };

export function Toasts() {
  const { toasts, dismissToast } = useEditor();
  return (
    <div className="toasts" data-testid="toasts">
      {toasts.map((toast) => {
        const Icon = ICONS[toast.tone];
        return (
          <div key={toast.id} className={`toast toast-${toast.tone}`}>
            <Icon size={16} />
            <div className="toast-body">
              <div className="strong">{toast.title}</div>
              {toast.message && <div className="small muted">{toast.message}</div>}
              {toast.action && (
                <button className="link" onClick={toast.action.run}>
                  {toast.action.label}
                </button>
              )}
            </div>
            <button className="icon-btn tiny" onClick={() => dismissToast(toast.id)} aria-label="Dismiss">
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
