import { generateManifest } from "material-icon-theme";
import { FileIcon, FolderIcon } from "../../components/Icons";
import type { IconPack, IconRef } from "./types";
import testGoUrl from "./icons/test-go.svg?url";

// Eager URL glob: the bundle carries only the URL strings; the SVGs ship as
// assets and are fetched per icon on first render.
const svgUrls = import.meta.glob("/node_modules/material-icon-theme/icons/*.svg", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

// Upstream-maintained mapping: extensions, special filenames, folder names.
const manifest = generateManifest();

function urlFor(iconName: string | undefined): IconRef | null {
  if (!iconName) return null;
  const iconPath = manifest.iconDefinitions?.[iconName]?.iconPath;
  if (!iconPath) return null;
  const file = iconPath.split("/").pop();
  const url = svgUrls[`/node_modules/material-icon-theme/icons/${file}`];
  return url ? { kind: "svg-url", url } : null;
}

function fileIcon(name: string): IconRef {
  const lower = name.toLowerCase();
  let icon = manifest.fileNames?.[lower];
  // Go test files: the manifest only matches dot-separated extensions, so
  // `_test.go` falls through to the plain Go icon. The set ships no test-go
  // flask, so we bring our own (material flask shape in Go cyan).
  if (!icon && lower.endsWith("_test.go")) return { kind: "svg-url", url: testGoUrl };
  if (!icon) {
    // Longest compound extension wins: foo.test.ts → "test.ts" before "ts".
    const parts = lower.split(".");
    for (let i = 1; i < parts.length && !icon; i++) {
      icon = manifest.fileExtensions?.[parts.slice(i).join(".")];
    }
  }
  return urlFor(icon) ?? urlFor(manifest.file) ?? { kind: "component", Component: FileIcon };
}

function folderIcon(name: string, open: boolean): IconRef {
  const lower = name.toLowerCase();
  const icon = open ? manifest.folderNamesExpanded?.[lower] : manifest.folderNames?.[lower];
  const fallback = open ? manifest.folderExpanded : manifest.folder;
  return urlFor(icon) ?? urlFor(fallback) ?? { kind: "component", Component: FolderIcon };
}

export const materialPack: IconPack = {
  id: "material",
  label: "Material Icons",
  fileIcon,
  folderIcon,
};
