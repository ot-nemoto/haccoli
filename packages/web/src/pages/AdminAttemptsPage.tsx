import {
  type AdminAttempt,
  type AdminAttemptPage,
  type AdminExam,
  type AdminIssueAttemptRequest,
  ATTEMPT_STATUSES,
  type AttemptStatus,
} from "@haccoli/shared";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { messageOf } from "../api.js";
import { useApi } from "../auth/useApi.js";
import { AttemptTable } from "../components/AdminAttempts.js";
import { useUsers } from "../hooks/useUsers.js";
import { ADMIN_STATUS_LABELS, jstDateAfter, withQuery } from "../lib/admin.js";
import { formatJst } from "../lib/format.js";
import { AdminLayout } from "./AdminLayout.js";

/** 発行の画面の期限日の既定（今日から何日後か） */
const DEFAULT_DEADLINE_DAYS = 7;

const isStatus = (v: string | null): v is AttemptStatus =>
  ATTEMPT_STATUSES.includes(v as AttemptStatus);

/** 受験の一覧・発行（docs/design.md §14.7 /admin/attempts） */
export function AdminAttemptsPage() {
  const api = useApi();
  // 絞り込みは URL に残す（ダッシュボードの件数から移る・再読み込みしても保つ）
  const [params, setParams] = useSearchParams();
  const rawStatus = params.get("status");
  const status = isStatus(rawStatus) ? rawStatus : "";
  const examId = params.get("examId") ?? "";
  const [exams, setExams] = useState<AdminExam[]>();
  const [items, setItems] = useState<AdminAttempt[]>();
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [issued, setIssued] = useState<AdminAttempt>();
  const latest = useRef(0);

  const load = useCallback(
    async (opts: { status: string; examId: string; cursor?: string }) => {
      const id = ++latest.current;
      setLoading(true);
      setError(undefined);
      try {
        const page = await api<AdminAttemptPage>(withQuery("/admin/attempts", opts));
        if (id !== latest.current) return;
        setItems((prev) => (opts.cursor ? [...(prev ?? []), ...page.items] : page.items));
        setCursor(page.cursor);
      } catch (e) {
        if (id === latest.current) setError(messageOf(e));
      } finally {
        if (id === latest.current) setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    void load({ status, examId });
  }, [load, status, examId]);

  useEffect(() => {
    let canceled = false;
    api<AdminExam[]>("/admin/exams")
      .then((e) => !canceled && setExams(e))
      .catch((e) => !canceled && setError(messageOf(e)));
    return () => {
      canceled = true;
    };
  }, [api]);

  const setFilter = (key: "status" | "examId", value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <AdminLayout>
      <h1>受験</h1>
      {issued && (
        <p className="notice" role="status">
          {issued.candidateName} さんに「{issued.examTitle}」を発行しました（期限{" "}
          {formatJst(issued.deadlineAt)}）。
          <Link to={`/admin/attempts/${encodeURIComponent(issued.attemptId)}`}>詳細を開く</Link>
          。受験の URL（{window.location.origin}/login）を候補者に連絡してください。
        </p>
      )}
      <IssueForm
        exams={exams}
        onIssued={(a) => {
          setIssued(a);
          void load({ status, examId });
        }}
      />

      <div className="toolbar">
        <label className="inline">
          状態
          <select value={status} onChange={(e) => setFilter("status", e.target.value)}>
            <option value="">すべて</option>
            {ATTEMPT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {ADMIN_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="inline">
          課題
          <select value={examId} onChange={(e) => setFilter("examId", e.target.value)}>
            <option value="">すべて</option>
            {exams?.map((e) => (
              <option key={e.examId} value={e.examId}>
                {e.title}（{e.examId}）
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted">
        回答中・未着手は期限が近い順、それ以外は期限が新しい順に、状態ごとにまとめて表示します。
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!items && loading && <p>読み込み中…</p>}
      {items?.length === 0 && <p>この条件の受験はありません。</p>}
      {items && items.length > 0 && <AttemptTable label="受験の一覧" items={items} />}
      {cursor && (
        <p>
          <button
            type="button"
            className="secondary"
            disabled={loading}
            onClick={() => void load({ status, examId, cursor })}
          >
            {loading ? "読み込み中…" : "さらに読み込む"}
          </button>
        </p>
      )}
    </AdminLayout>
  );
}

function IssueForm(props: { exams?: AdminExam[]; onIssued: (attempt: AdminAttempt) => void }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <p>
        <button type="button" onClick={() => setOpen(true)}>
          受験を発行する
        </button>
      </p>
    );
  }
  return (
    <IssueFormBody
      exams={props.exams}
      onIssued={(a) => {
        setOpen(false);
        props.onIssued(a);
      }}
      onCancel={() => setOpen(false)}
    />
  );
}

/** 開いたときだけ候補者の一覧を読む */
function IssueFormBody(props: {
  exams?: AdminExam[];
  onIssued: (attempt: AdminAttempt) => void;
  onCancel: () => void;
}) {
  const api = useApi();
  const { users: candidates, incomplete } = useUsers("candidate");
  const [email, setEmail] = useState("");
  const [examId, setExamId] = useState("");
  const [deadline, setDeadline] = useState(() => jstDateAfter(DEFAULT_DEADLINE_DAYS));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const active = candidates?.filter((u) => !u.disabled);
  const selectedExam = examId || props.exams?.[0]?.examId || "";

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      const body: AdminIssueAttemptRequest = {
        email: email.trim(),
        examId: selectedExam,
        deadline,
      };
      const attempt = await api<AdminAttempt>("/admin/attempts", {
        method: "POST",
        body: JSON.stringify(body),
      });
      props.onIssued(attempt);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel" aria-label="受験の発行" onSubmit={onSubmit}>
      <h2>受験の発行</h2>
      <label>
        候補者のメールアドレス
        <input
          type="email"
          required
          list="issue-candidates"
          autoComplete="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <datalist id="issue-candidates">
          {active?.map((u) => (
            <option key={u.sub} value={u.email}>
              {u.name}
            </option>
          ))}
        </datalist>
      </label>
      <p className="muted">
        候補者として登録済みの人だけに発行できます。未登録なら、先に
        <Link to="/admin/users">利用者</Link>の画面で登録してください。
        {incomplete && " 候補者の一覧を一部読み込めなかったため、入力の候補に出ない人がいます。"}
      </p>
      <label>
        課題
        <select required value={selectedExam} onChange={(e) => setExamId(e.target.value)}>
          {props.exams?.map((x) => (
            <option key={x.examId} value={x.examId}>
              {x.title}（{x.examId}、v{x.latestVersion}）
            </option>
          ))}
        </select>
      </label>
      <label>
        期限日
        <input
          type="date"
          required
          min={jstDateAfter(1)}
          value={deadline}
          onChange={(e) => setDeadline(e.target.value)}
        />
      </label>
      <p className="muted">
        期限は指定した日の 23:59（日本時間）です。翌日以降を指定できます。課題は最新版で発行します。
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="confirm-actions">
        <button type="submit" disabled={busy || !selectedExam}>
          {busy ? "発行中…" : "発行する"}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={props.onCancel}>
          キャンセル
        </button>
      </div>
    </form>
  );
}
