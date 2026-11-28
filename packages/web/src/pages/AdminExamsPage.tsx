import type { AdminExam, AdminSaveDraftRequest, AdminSaveDraftResponse } from "@haccoli/shared";
import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { messageOf } from "../api.js";
import { useApi } from "../auth/useApi.js";
import { DRAFT_STATE_LABELS, draftState, EXAM_ID_PATTERN, emptyDraft } from "../lib/examDraft.js";
import { formatJst } from "../lib/format.js";
import { AdminLayout } from "./AdminLayout.js";

/** 課題の一覧・新規作成（docs/design.md §14.7 /admin/exams） */
export function AdminExamsPage() {
  const api = useApi();
  const [exams, setExams] = useState<AdminExam[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let canceled = false;
    api<AdminExam[]>("/admin/exams")
      .then((e) => !canceled && setExams(e))
      .catch((e) => !canceled && setError(messageOf(e)));
    return () => {
      canceled = true;
    };
  }, [api]);

  return (
    <AdminLayout>
      <h1>課題</h1>
      <p className="muted">
        課題は画面で編集し、公開すると新しい版になります。発行済みの受験は、発行したときの版のままです。
      </p>
      <CreateForm />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!exams && !error && <p>読み込み中…</p>}
      {exams?.length === 0 && <p>課題はまだありません。</p>}
      {exams && exams.length > 0 && (
        <table className="list" aria-label="課題の一覧">
          <thead>
            <tr>
              <th>課題</th>
              <th>最新版</th>
              <th>下書き</th>
              <th>下書きの保存</th>
            </tr>
          </thead>
          <tbody>
            {exams.map((e) => {
              const state = draftState(e);
              return (
                <tr key={e.examId}>
                  <td className="wrap">
                    <Link to={`/admin/exams/${encodeURIComponent(e.examId)}`}>{e.title}</Link>{" "}
                    <span className="muted">{e.examId}</span>
                  </td>
                  <td>
                    {e.latestVersion !== undefined ? (
                      `v${e.latestVersion}`
                    ) : (
                      <span className="badge badge-unknown">未公開</span>
                    )}
                  </td>
                  <td>
                    {state === "none" ? (
                      <span className="muted">{DRAFT_STATE_LABELS[state]}</span>
                    ) : (
                      <span
                        className={`badge ${state === "stale" ? "badge-canceled" : state === "published" ? "badge-graded" : "badge-in_progress"}`}
                      >
                        {DRAFT_STATE_LABELS[state]}
                      </span>
                    )}
                  </td>
                  <td className="wrap">
                    {e.draft && `${formatJst(e.draft.updatedAt)}（${e.draft.updatedBy.name}）`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </AdminLayout>
  );
}

function CreateForm() {
  const api = useApi();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [examId, setExamId] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (!open) {
    return (
      <p>
        <button type="button" onClick={() => setOpen(true)}>
          新しい課題を作る
        </button>
      </p>
    );
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const id = examId.trim();
      const body: AdminSaveDraftRequest = {
        definition: emptyDraft(id, title.trim()),
        version: 0,
        create: true,
      };
      await api<AdminSaveDraftResponse>(`/admin/exams/${encodeURIComponent(id)}/draft`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      navigate(`/admin/exams/${encodeURIComponent(id)}`);
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };

  return (
    <form className="panel" aria-label="新しい課題" onSubmit={onSubmit}>
      <h2>新しい課題</h2>
      <label>
        課題 ID
        <input
          required
          pattern={EXAM_ID_PATTERN}
          value={examId}
          onChange={(e) => setExamId(e.target.value)}
          disabled={busy}
        />
      </label>
      <p className="muted">
        英小文字・数字・ハイフン（先頭は英数字、63 文字以内）。作った後は変更できません。
      </p>
      <label>
        題名
        <input
          required
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={busy}
        />
      </label>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="confirm-actions">
        <button type="submit" disabled={busy}>
          {busy ? "作成中…" : "作成して編集する"}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={() => setOpen(false)}>
          キャンセル
        </button>
      </div>
    </form>
  );
}
