import { builtinPack } from "./builtin";
import { materialPack } from "./material";
import type { IconPack } from "./types";

export type { IconPack, IconRef } from "./types";

export const ICON_PACKS: IconPack[] = [materialPack, builtinPack];

export const DEFAULT_ICON_PACK_ID = materialPack.id;

export function getIconPack(id: string): IconPack {
  return ICON_PACKS.find((p) => p.id === id) ?? materialPack;
}
