import { ASSIGNMENT_STATUS_LABELS, type GraderAssignmentSummary } from "@haccoli/shared";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { messageOf } from "../api.js";
import { useApi } from "../auth/useApi.js";
import { formatJst } from "../lib/format.js";
import { Layout } from "./Layout.js";

/** 採点者のトップ（担当一覧）。docs/design.md §9 /grader */
export function GraderHomePage() {
  const api = useApi();
  const [items, setItems] = useState<GraderAssignmentSummary[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api<GraderAssignmentSummary[]>("/grader/assignments")
      .then(setItems)
      .catch((e: unknown) => setError(messageOf(e)));
  }, [api]);

  return (
    <Layout userRole="grader">
      <h1>担当一覧</h1>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!items && !error && <p>読み込み中…</p>}
      {items?.length === 0 && <p>現在、担当している採点はありません。</p>}
      {items && items.length > 0 && (
        <table className="list">
          <thead>
            <tr>
              <th>候補者</th>
              <th>課題</th>
              <th>提出日時</th>
              <th>採点</th>
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.attemptId}>
                <td>
                  <Link to={`/grader/${a.attemptId}`}>{a.candidateName}</Link>
                </td>
                <td>{a.examTitle}</td>
                <td>{a.submittedAt ? formatJst(a.submittedAt) : ""}</td>
                <td>
                  <span className={`badge badge-assign-${a.assignmentStatus.toLowerCase()}`}>
                    {ASSIGNMENT_STATUS_LABELS[a.assignmentStatus]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Layout>
  );
}
