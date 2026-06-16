import { comboFor, formatCombo } from "../lib/shortcuts";

/** Right-aligned keybinding hint for a `.ctx-menu` button. Renders nothing when
 *  the action has no bound combo. */
export function CtxShortcut({ id }: { id: string }) {
  const combo = formatCombo(comboFor(id));
  return combo ? <span className="ctx-kb">{combo}</span> : null;
}
