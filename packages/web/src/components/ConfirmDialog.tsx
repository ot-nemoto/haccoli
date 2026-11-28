import type { ReactNode } from "react";

/**
 * 元に戻せない操作の確認（docs/design.md §14.7）。提出・採点の確定と同じく、
 * 操作の近くに確認の枠を出す。
 */
export function ConfirmDialog(props: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="confirm" role="dialog" aria-label={props.title}>
      <strong>{props.title}</strong>
      <div>{props.children}</div>
      <div className="confirm-actions">
        <button type="button" className="danger" disabled={props.busy} onClick={props.onConfirm}>
          {props.busy ? "処理中…" : props.confirmLabel}
        </button>
        <button type="button" className="secondary" disabled={props.busy} onClick={props.onCancel}>
          キャンセル
        </button>
      </div>
    </div>
  );
}
