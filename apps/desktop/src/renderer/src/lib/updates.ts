import type { UpdateStatus } from "../../../shared/api";
import { api, useEditor } from "./store";

/** Shows a sticky toast when a newer lamsa is ready to install or available to download, once per version. Returns the unsubscribe. */
export function installUpdateToasts(): () => void {
  let shown: string | undefined;
  const show = (status: UpdateStatus) => {
    if (status.state === "none") return;
    const key = `${status.state}:${status.version}`;
    if (key === shown) return;
    shown = key;
    const { toast } = useEditor.getState();
    if (status.state === "ready") {
      toast({
        tone: "neutral",
        title: `lamsa ${status.version} is ready`,
        message: "Restart to update, or it installs when you quit.",
        action: { label: "Restart", run: () => void api().installUpdate() },
        sticky: true,
      });
    } else {
      toast({
        tone: "neutral",
        title: `lamsa ${status.version} is available`,
        message: "Download the new version from the releases page.",
        action: { label: "Download", run: () => void api().openUpdateDownload() },
        sticky: true,
      });
    }
  };
  void api().updateStatus().then(show);
  return api().onUpdateStatus(show);
}
