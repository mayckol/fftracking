import { useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import MergeEditor from "./MergeEditor";

// Root of the standalone merge window (main.tsx routes `view=merge` here). Params
// arrive on the URL; on resolve it tells the main window to refresh, then closes.
export default function MergeWindow() {
  const params = new URLSearchParams(window.location.search);
  const repo = params.get("repo") ?? "";
  const path = params.get("path") ?? "";
  const ours = params.get("ours") ?? "ours";
  const theirs = params.get("theirs") ?? "theirs";
  const [toast, setToast] = useState<{ msg: string; error: boolean } | null>(null);

  const notify = (msg: string, error = false) => {
    setToast({ msg, error });
    window.setTimeout(() => setToast(null), 3200);
  };
  const close = () => getCurrentWindow().close();

  if (!repo || !path) {
    return <div className="dbg-hint">Missing merge parameters.</div>;
  }

  return (
    <>
      <MergeEditor
        windowed
        repoPath={repo}
        path={path}
        oursLabel={ours}
        theirsLabel={theirs}
        toast={notify}
        onResolved={async () => {
          await emit("merge-resolved", { path });
          close();
        }}
        onClose={close}
      />
      {toast && <div className={`toast${toast.error ? " error" : ""}`}>{toast.msg}</div>}
    </>
  );
}
