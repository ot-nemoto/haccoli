import type { AdminExam } from "@haccoli/shared";
import { type FormEvent, useEffect, useState } from "react";
import { messageOf } from "../api.js";
import { useApi } from "../auth/useApi.js";
import { formatJst } from "../lib/format.js";
import { AdminLayout } from "./AdminLayout.js";

/** 採点結果の CSV 出力（docs/design.md §14.7 /admin/results） */
export function AdminResultsPage() {
  const api = useApi();
  const [exams, setExams] = useState<AdminExam[]>();
  const [examId, setExamId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<{ fileName: string; at: string }>();

  useEffect(() => {
    let canceled = false;
    api<AdminExam[]>("/admin/exams")
      .then((e) => {
        if (canceled) return;
        // 未公開の課題（管理画面で作成して、まだ公開していないもの）には受験が無いので出さない
        const published = e.filter((x) => x.latestVersion !== undefined);
        setExams(published);
        setExamId((cur) => cur || published[0]?.examId || "");
      })
      .catch((e) => !canceled && setError(`課題の一覧を読み込めませんでした: ${messageOf(e)}`));
    return () => {
      canceled = true;
    };
  }, [api]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      const blob = await api<Blob>(
        `/admin/exams/${encodeURIComponent(examId)}/results.csv`,
        undefined,
        "blob",
      );
      const fileName = `results-${examId}.csv`;
      // 認証ヘッダーが必要なため、リンクではなく取得した内容を保存させる
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.append(a);
      a.click();
      a.remove();
      // 保存の開始を待ってから、メモリ上の内容を解放する
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setDone({ fileName, at: new Date().toISOString() });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AdminLayout>
      <h1>採点結果</h1>
      <p className="notice">
        <strong>候補者・採点者の氏名とメールアドレスを含みます。</strong>
        共有するときは社内の決められた場所に置き、手元のファイルは用が済んだら削除してください。出力したことは監査ログに残ります。
      </p>
      <form className="panel" aria-label="採点結果の出力" onSubmit={onSubmit}>
        <label>
          課題
          <select required value={examId} onChange={(e) => setExamId(e.target.value)}>
            {exams?.map((x) => (
              <option key={x.examId} value={x.examId}>
                {x.title}（{x.examId}）
              </option>
            ))}
          </select>
        </label>
        <p className="muted">
          受験 × 採点者ごとに 1 行で、問題ごとの点数とコメント・総評を出力します（CLI の
          result:export と同じ形式）。採点者を割り当てていない受験は、採点者なしで 1 行です。
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="confirm-actions">
          <button type="submit" disabled={busy || !examId}>
            {busy ? "出力中…" : "CSV を出力"}
          </button>
        </div>
      </form>
      {done && (
        <p className="notice" role="status">
          {done.fileName} を出力しました（{formatJst(done.at)}）。
        </p>
      )}
    </AdminLayout>
  );
}
