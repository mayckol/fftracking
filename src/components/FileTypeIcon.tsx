import { getIconPack, type IconRef } from "../lib/iconPacks";
import { useUIPrefs } from "../lib/uiPrefs";

// `name` may be a full path; only the basename matters for matching.
function basenameOf(name: string): string {
  return name.split("/").pop() ?? name;
}

function render(ref: IconRef, open?: boolean) {
  if (ref.kind === "svg-url") {
    return <img className="ftype-icon" src={ref.url} alt="" aria-hidden draggable={false} />;
  }
  return <ref.Component open={open} />;
}

export function FileTypeIcon({ name }: { name: string }) {
  const prefs = useUIPrefs();
  return render(getIconPack(prefs.iconPack).fileIcon(basenameOf(name)));
}

export function FolderTypeIcon({ name, open = false }: { name: string; open?: boolean }) {
  const prefs = useUIPrefs();
  return render(getIconPack(prefs.iconPack).folderIcon(basenameOf(name), open), open);
}
