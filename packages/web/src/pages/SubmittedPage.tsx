import type { CandidateAttemptSummary } from "@haccoli/shared";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { messageOf } from "../api.js";
import { useApi } from "../auth/useApi.js";
import { formatJst } from "../lib/format.js";
import { Layout } from "./Layout.js";

/** 提出完了 */
export function SubmittedPage() {
  const { attemptId = "" } = useParams();
  const api = useApi();
  const [attempt, setAttempt] = useState<CandidateAttemptSummary>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api<CandidateAttemptSummary>(`/candidate/attempts/${encodeURIComponent(attemptId)}`)
      .then(setAttempt)
      .catch((e: unknown) => setError(messageOf(e)));
  }, [api, attemptId]);

  return (
    <Layout userRole="candidate">
      <h1>提出が完了しました</h1>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {attempt && (
        <>
          <p>「{attempt.examTitle}」の回答を受け付けました。ご協力ありがとうございました。</p>
          {attempt.submittedAt && <p>提出日時: {formatJst(attempt.submittedAt)}</p>}
          <p>提出後は回答を変更できません。このままブラウザを閉じていただいて構いません。</p>
        </>
      )}
      <p>
        <Link to={`/exam/${attemptId}`}>回答内容を確認する</Link>
      </p>
    </Layout>
  );
}
