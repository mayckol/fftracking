import { type ReactNode, useState } from "react";
import { suppressConfirm } from "../lib/confirmPrefs";

interface Props {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  /** When set, shows a "Don't show this again" checkbox that suppresses this
   *  confirmation by id on confirm. */
  suppressId?: string;
  /** Extra controls (e.g. an option checkbox) rendered above the actions. */
  extra?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmModal({
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  danger,
  suppressId,
  extra,
  onConfirm,
  onCancel,
}: Props) {
  const [hide, setHide] = useState(false);
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{message}</p>
        {extra}
        {suppressId && (
          <label className="modal-check">
            <input type="checkbox" checked={hide} onChange={(e) => setHide(e.target.checked)} />
            Don’t show this again
          </label>
        )}
        <div className="modal-actions">
          <button className="tbtn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            className={`tbtn ${danger ? "danger" : "primary"}`}
            onClick={() => {
              if (hide && suppressId) suppressConfirm(suppressId);
              onConfirm();
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
