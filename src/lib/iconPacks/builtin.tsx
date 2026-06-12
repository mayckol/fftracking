import { FileIcon, FolderIcon, GoIcon } from "../../components/Icons";
import type { IconPack } from "./types";

// The original hand-rolled icons, preserved as a selectable pack.
export const builtinPack: IconPack = {
  id: "builtin",
  label: "Built-in",
  fileIcon: (name) => ({
    kind: "component",
    Component: name.toLowerCase().endsWith(".go") ? GoIcon : FileIcon,
  }),
  folderIcon: () => ({ kind: "component", Component: FolderIcon }),
};
