import type { ComponentType } from "react";

export type IconRef =
  | { kind: "svg-url"; url: string }
  | { kind: "component"; Component: ComponentType<{ open?: boolean }> };

/** Pluggable file/folder icon provider. Names are bare entry names
 *  (basenames); resolution is case-insensitive. */
export interface IconPack {
  id: string;
  label: string;
  fileIcon(name: string): IconRef;
  folderIcon(name: string, open: boolean): IconRef;
}
