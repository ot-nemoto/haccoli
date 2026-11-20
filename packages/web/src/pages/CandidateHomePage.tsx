import type { CandidateAttemptSummary } from "@haccoli/shared";
import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router";
import { messageOf } from "../api.js";
import { useApi } from "../auth/useApi.js";
import { Deadline, StatusBadge } from "../components/AttemptStatus.js";
import { Layout } from "./Layout.js";

/** 候補者のトップ（自分の課題一覧）。1 件だけなら課題画面へ自動遷移する（docs/design.md §9） */
export function CandidateHomePage() {
  const api = useApi();
  const [attempts, setAttempts] = useState<CandidateAttemptSummary[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api<CandidateAttemptSummary[]>("/candidate/attempts")
      .then(setAttempts)
      .catch((e: unknown) => setError(messageOf(e)));
  }, [api]);

  if (attempts?.length === 1 && attempts[0]) {
    return <Navigate to={`/exam/${attempts[0].attemptId}`} replace />;
  }

  const now = new Date();
  return (
    <Layout userRole="candidate">
      <h1>採用課題</h1>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!attempts && !error && <p>読み込み中…</p>}
      {attempts?.length === 0 && <p>現在、表示できる課題はありません。</p>}
      {attempts && attempts.length > 1 && (
        <ul className="attempt-list">
          {attempts.map((a) => (
            <li key={a.attemptId}>
              <Link to={`/exam/${a.attemptId}`}>{a.examTitle}</Link>
              <StatusBadge status={a.status} />
              <Deadline deadlineAt={a.deadlineAt} status={a.status} now={now} />
            </li>
          ))}
        </ul>
      )}
    </Layout>
  );
}
