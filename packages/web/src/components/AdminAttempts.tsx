import type { AdminAttempt, AttemptStatus } from "@haccoli/shared";
import { Link } from "react-router";
import { ADMIN_STATUS_LABELS } from "../lib/admin.js";
import { formatJst, remainingLabel } from "../lib/format.js";

/** 管理画面の状態の表示（採点中・採点完了を区別する） */
export function AdminStatusBadge(props: { status: AttemptStatus }) {
  return (
    <span className={`badge badge-${props.status.toLowerCase()}`}>
      {ADMIN_STATUS_LABELS[props.status]}
    </span>
  );
}

const open = (s: AttemptStatus) => s === "NOT_STARTED" || s === "IN_PROGRESS";

/** 受験の一覧の表（一覧・ダッシュボード）。候補者の氏名から詳細へ移る */
export function AttemptTable(props: { label: string; items: AdminAttempt[]; now?: Date }) {
  const now = props.now ?? new Date();
  return (
    <table className="list" aria-label={props.label}>
      <thead>
        <tr>
          <th>候補者</th>
          <th>課題</th>
          <th>状態</th>
          <th>期限</th>
          <th>提出</th>
          <th>採点者</th>
        </tr>
      </thead>
      <tbody>
        {props.items.map((a) => (
          <tr key={a.attemptId}>
            <td>
              <Link to={`/admin/attempts/${encodeURIComponent(a.attemptId)}`}>
                {a.candidateName}
              </Link>
            </td>
            <td className="wrap">
              {a.examTitle} <span className="muted">v{a.examVersion}</span>
            </td>
            <td>
              <AdminStatusBadge status={a.status} />
            </td>
            <td>
              {formatJst(a.deadlineAt)}
              {open(a.status) && (
                <span className="muted">（{remainingLabel(a.deadlineAt, now)}）</span>
              )}
            </td>
            <td>{a.submittedAt ? formatJst(a.submittedAt) : ""}</td>
            <td>{a.assignmentCount ? `${a.assignmentCount} 人` : "未割り当て"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
