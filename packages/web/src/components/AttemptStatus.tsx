import { ATTEMPT_STATUS_LABELS, type AttemptStatus } from "@haccoli/shared";
import { formatJst, remainingLabel } from "../lib/format.js";

export function StatusBadge(props: { status: AttemptStatus }) {
  return (
    <span className={`badge badge-${props.status.toLowerCase()}`}>
      {ATTEMPT_STATUS_LABELS[props.status]}
    </span>
  );
}

/** 期限日時と残り時間 */
export function Deadline(props: { deadlineAt: string; status: AttemptStatus; now: Date }) {
  const open = props.status === "NOT_STARTED" || props.status === "IN_PROGRESS";
  return (
    <span className="deadline">
      期限 {formatJst(props.deadlineAt)}
      {open && <strong> （{remainingLabel(props.deadlineAt, props.now)}）</strong>}
    </span>
  );
}
