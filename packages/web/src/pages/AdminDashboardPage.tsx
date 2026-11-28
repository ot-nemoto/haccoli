import type { AdminSummary, AttemptStatus } from "@haccoli/shared";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { messageOf } from "../api.js";
import { useApi } from "../auth/useApi.js";
import { AttemptTable } from "../components/AdminAttempts.js";
import { ADMIN_STATUS_LABELS } from "../lib/admin.js";
import { formatJst } from "../lib/format.js";
import { AdminLayout } from "./AdminLayout.js";

/** 件数の並び（進行中 → 提出後 → 終了） */
const COUNT_ORDER: AttemptStatus[] = [
  "NOT_STARTED",
  "IN_PROGRESS",
  "SUBMITTED",
  "GRADING",
  "GRADED",
  "EXPIRED",
  "CANCELED",
];

/** ダッシュボード（docs/design.md §14.7 /admin） */
export function AdminDashboardPage() {
  const api = useApi();
  const [summary, setSummary] = useState<AdminSummary>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let canceled = false;
    api<AdminSummary>("/admin/summary")
      .then((s) => !canceled && setSummary(s))
      .catch((e) => !canceled && setError(messageOf(e)));
    return () => {
      canceled = true;
    };
  }, [api]);

  const now = summary ? new Date(summary.at) : undefined;
  return (
    <AdminLayout>
      <h1>ダッシュボード</h1>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!summary && !error && <p>読み込み中…</p>}
      {summary && (
        <>
          <p className="muted">{formatJst(summary.at)} 時点</p>
          <ul className="status-counts" aria-label="状態ごとの受験数">
            {COUNT_ORDER.map((s) => (
              <li key={s}>
                <Link to={`/admin/attempts?status=${s}`}>
                  <span className="count">{summary.counts[s]}</span>
                  <span>{ADMIN_STATUS_LABELS[s]}</span>
                </Link>
              </li>
            ))}
          </ul>

          <h2>期限が近い受験（{summary.dueSoonDays} 日以内）</h2>
          {summary.dueSoon.length === 0 ? (
            <p>ありません。</p>
          ) : (
            <>
              <AttemptTable label="期限が近い受験" items={summary.dueSoon} now={now} />
              {summary.dueSoonTotal > summary.dueSoon.length && (
                <p className="muted">
                  ほか {summary.dueSoonTotal - summary.dueSoon.length} 件。
                  <Link to="/admin/attempts?status=IN_PROGRESS">回答中</Link>・
                  <Link to="/admin/attempts?status=NOT_STARTED">未着手</Link>
                  の一覧で確かめてください。
                </p>
              )}
            </>
          )}

          <h2>採点者が未割り当ての提出</h2>
          {summary.unassigned.length === 0 ? (
            <p>ありません。</p>
          ) : (
            <>
              <AttemptTable label="採点者が未割り当ての提出" items={summary.unassigned} now={now} />
              {summary.unassignedTotal > summary.unassigned.length && (
                <p className="muted">
                  ほか {summary.unassignedTotal - summary.unassigned.length} 件。
                  <Link to="/admin/attempts?status=SUBMITTED">提出済み</Link>
                  の一覧で確かめてください。
                </p>
              )}
            </>
          )}
        </>
      )}
    </AdminLayout>
  );
}
