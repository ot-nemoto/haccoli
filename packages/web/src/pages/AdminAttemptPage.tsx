import {
  type AdminAssignResponse,
  type AdminAttempt,
  type AdminAttemptDetail,
  type AdminUser,
  ASSIGNMENT_STATUS_LABELS,
  type DownloadUrlResponse,
} from "@haccoli/shared";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { messageOf } from "../api.js";
import { useApi } from "../auth/useApi.js";
import { AdminStatusBadge } from "../components/AdminAttempts.js";
import { AnswerView } from "../components/AnswerView.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { Markdown } from "../components/Markdown.js";
import { useUsers } from "../hooks/useUsers.js";
import { canAssign, canCancel, canExtend, deadlineDateOf, jstDateAfter } from "../lib/admin.js";
import { formatJst, remainingLabel } from "../lib/format.js";
import { AdminLayout } from "./AdminLayout.js";

/** 受験の詳細（docs/design.md §14.7 /admin/attempts/:attemptId） */
export function AdminAttemptPage() {
  const { attemptId = "" } = useParams();
  const api = useApi();
  const path = `/admin/attempts/${encodeURIComponent(attemptId)}`;
  const [detail, setDetail] = useState<AdminAttemptDetail>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  /** 最後に出した読み込み。操作を続けたとき、先に出した読み直しの応答で新しい表示を上書きしない */
  const latest = useRef(0);

  const load = useCallback(async () => {
    const id = ++latest.current;
    try {
      const d = await api<AdminAttemptDetail>(path);
      if (id !== latest.current) return;
      setDetail(d);
      setError(undefined);
    } catch (e) {
      if (id === latest.current) setError(messageOf(e));
    }
  }, [api, path]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 操作の後は、応答の受験をすぐ表示に反映し（読み直しが終わるまで古い期限・状態を出さない）、
   * 割り当て・採点もそろうよう詳細を読み直す
   */
  const done = (message: string, attempt?: AdminAttempt) => {
    setNotice(message);
    if (attempt) {
      // 応答を反映したら、それより前に出した読み直しの結果は使わない
      latest.current++;
      setDetail((prev) => prev && { ...prev, attempt });
    }
    void load();
  };

  return (
    <AdminLayout>
      <p>
        <Link to="/admin/attempts">受験の一覧へ</Link>
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!detail && !error && <p>読み込み中…</p>}
      {detail && (
        <>
          <Header detail={detail} />
          {notice && (
            <p className="notice" role="status">
              {notice}
            </p>
          )}
          <Actions
            attempt={detail.attempt}
            assigned={detail.assignments.map((a) => a.graderSub)}
            path={path}
            onDone={done}
          />
          <Assignments detail={detail} />
          <Answers
            detail={detail}
            onDownload={async (qid) => {
              const res = await api<DownloadUrlResponse>(
                `${path}/answers/${encodeURIComponent(qid)}/download-url`,
                { method: "POST" },
              );
              window.location.assign(res.url);
            }}
          />
        </>
      )}
    </AdminLayout>
  );
}

function Header(props: { detail: AdminAttemptDetail }) {
  const { attempt: a, candidateEmail } = props.detail;
  const open = a.status === "NOT_STARTED" || a.status === "IN_PROGRESS";
  return (
    <>
      <h1>
        {a.candidateName} さん ／ {a.examTitle}
      </h1>
      <dl className="detail attempt-meta">
        <div>
          <dt>状態</dt>
          <dd>
            <AdminStatusBadge status={a.status} />
          </dd>
        </div>
        <div>
          <dt>メールアドレス</dt>
          <dd>{candidateEmail ?? "（個人データを削除済み）"}</dd>
        </div>
        <div>
          <dt>課題</dt>
          <dd>
            {a.examId} v{a.examVersion}
          </dd>
        </div>
        <div>
          <dt>期限</dt>
          <dd>
            {formatJst(a.deadlineAt)}
            {open && `（${remainingLabel(a.deadlineAt)}）`}
          </dd>
        </div>
        <div>
          <dt>発行</dt>
          <dd>{formatJst(a.issuedAt)}</dd>
        </div>
        {a.startedAt && (
          <div>
            <dt>開始</dt>
            <dd>{formatJst(a.startedAt)}</dd>
          </div>
        )}
        {a.submittedAt && (
          <div>
            <dt>提出</dt>
            <dd>{formatJst(a.submittedAt)}</dd>
          </div>
        )}
        {a.canceledAt && (
          <div>
            <dt>取消</dt>
            <dd>{formatJst(a.canceledAt)}</dd>
          </div>
        )}
        <div>
          <dt>受験 ID</dt>
          <dd className="hash">{a.attemptId}</dd>
        </div>
      </dl>
    </>
  );
}

/** 期限の変更・取消・採点者の割り当て。その状態でできない操作は出さない */
function Actions(props: {
  attempt: AdminAttempt;
  assigned: string[];
  path: string;
  onDone: (message: string, attempt?: AdminAttempt) => void;
}) {
  const { attempt: a } = props;
  const extend = canExtend(a.status);
  const cancel = canCancel(a.status);
  const assign = canAssign(a.status);
  if (!extend && !cancel && !assign) return null;
  return (
    <section className="panel wide-panel" aria-label="受験の操作">
      <h2>操作</h2>
      {extend && <ExtendForm attempt={a} path={props.path} onDone={props.onDone} />}
      {assign && <AssignForm assigned={props.assigned} path={props.path} onDone={props.onDone} />}
      {cancel && <CancelButton attempt={a} path={props.path} onDone={props.onDone} />}
    </section>
  );
}

function ExtendForm(props: {
  attempt: AdminAttempt;
  path: string;
  onDone: (message: string, attempt?: AdminAttempt) => void;
}) {
  const api = useApi();
  const tomorrow = jstDateAfter(1);
  const current = deadlineDateOf(props.attempt.deadlineAt);
  // 今の期限日と明日の遅い方（YYYY-MM-DD は文字列の順が日付の順）
  const [deadline, setDeadline] = useState(() => [current, tomorrow].sort()[1] ?? tomorrow);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const after = await api<AdminAttempt>(`${props.path}/extend`, {
        method: "POST",
        body: JSON.stringify({ deadline }),
      });
      props.onDone(`期限を ${formatJst(after.deadlineAt)} に変更しました。`, after);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="inline-form" aria-label="期限の変更" onSubmit={onSubmit}>
      <label className="inline">
        新しい期限日
        <input
          type="date"
          required
          min={tomorrow}
          value={deadline}
          onChange={(e) => setDeadline(e.target.value)}
        />
      </label>
      <button type="submit" disabled={busy}>
        {busy ? "変更中…" : "期限を変更"}
      </button>
      {props.attempt.status === "EXPIRED" && (
        <span className="muted">
          期限切れの受験は、期限を変更すると受験を続けられるようになります。
        </span>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  );
}

function AssignForm(props: {
  assigned: string[];
  path: string;
  onDone: (message: string, attempt?: AdminAttempt) => void;
}) {
  const api = useApi();
  const { users, incomplete } = useUsers("grader");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const choices = users?.filter((u) => !u.disabled && !props.assigned.includes(u.sub));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const res = await api<AdminAssignResponse>(`${props.path}/assign`, {
        method: "POST",
        body: JSON.stringify({ graderEmails: selected }),
      });
      const names = (xs: { name: string }[]) => xs.map((x) => `${x.name} さん`).join("・");
      setSelected([]);
      props.onDone(
        [
          res.assigned.length > 0 && `${names(res.assigned)}を採点者に割り当てました。`,
          res.skipped.length > 0 && `${names(res.skipped)}は割り当て済みでした。`,
        ]
          .filter(Boolean)
          .join(" "),
        res.attempt,
      );
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (u: AdminUser, on: boolean) =>
    setSelected((prev) => (on ? [...prev, u.email] : prev.filter((x) => x !== u.email)));

  return (
    <form aria-label="採点者の割り当て" onSubmit={onSubmit}>
      <fieldset className="inline-form">
        <legend>採点者の割り当て</legend>
        {!choices && <span>読み込み中…</span>}
        {choices?.length === 0 && <span className="muted">割り当てられる採点者はいません。</span>}
        {choices?.map((u) => (
          <label key={u.sub} className="inline">
            <input
              type="checkbox"
              checked={selected.includes(u.email)}
              onChange={(e) => toggle(u, e.target.checked)}
            />
            {u.name}
          </label>
        ))}
        <button type="submit" disabled={busy || selected.length === 0}>
          {busy ? "割り当て中…" : "割り当てる"}
        </button>
      </fieldset>
      <p className="muted">
        採点者には、候補者が提出した後に担当として表示されます。採点完了の受験に割り当てると、採点中に戻ります。
        {incomplete && " 採点者の一覧を一部読み込めませんでした。"}
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  );
}

function CancelButton(props: {
  attempt: AdminAttempt;
  path: string;
  onDone: (message: string, attempt?: AdminAttempt) => void;
}) {
  const api = useApi();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const cancel = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const after = await api<AdminAttempt>(`${props.path}/cancel`, { method: "POST" });
      setConfirming(false);
      props.onDone("受験を取り消しました。", after);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {confirming ? (
        <ConfirmDialog
          title="受験の取消"
          confirmLabel="取り消す"
          busy={busy}
          onConfirm={() => void cancel()}
          onCancel={() => {
            setConfirming(false);
            setError(undefined);
          }}
        >
          {props.attempt.candidateName} さんの「{props.attempt.examTitle}
          」を取り消します。候補者は回答・提出できなくなります。保存済みの回答は残ります。
          <strong>元に戻すことはできません。</strong>
        </ConfirmDialog>
      ) : (
        <button type="button" className="secondary" onClick={() => setConfirming(true)}>
          受験を取り消す
        </button>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}

function Assignments(props: { detail: AdminAttemptDetail }) {
  const { assignments } = props.detail;
  return (
    <section aria-label="採点者">
      <h2>採点者</h2>
      {assignments.length === 0 ? (
        <p>まだ割り当てていません。</p>
      ) : (
        <table className="list" aria-label="採点者の一覧">
          <thead>
            <tr>
              <th>採点者</th>
              <th>割り当て</th>
              <th>採点</th>
              <th>確定</th>
            </tr>
          </thead>
          <tbody>
            {assignments.map((a) => (
              <tr key={a.graderSub}>
                <td>{a.graderName}</td>
                <td>{formatJst(a.assignedAt)}</td>
                <td>
                  <span className={`badge badge-assign-${a.status.toLowerCase()}`}>
                    {ASSIGNMENT_STATUS_LABELS[a.status]}
                  </span>
                </td>
                <td>{a.finalizedAt ? formatJst(a.finalizedAt) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** 問題ごとの回答・採点基準と、すべての採点者の点数・コメント（下書きを含む） */
function Answers(props: {
  detail: AdminAttemptDetail;
  onDownload: (qid: string) => Promise<void>;
}) {
  const { detail } = props;
  const graderName = (sub: string) =>
    detail.assignments.find((a) => a.graderSub === sub)?.graderName ?? sub;
  const gradeState = (g: { finalizedAt?: string }) => (g.finalizedAt ? "確定" : "下書き");
  const totals = detail.grades.map((g) => ({
    g,
    total: Object.values(g.items).reduce((sum, i) => sum + (i.score ?? 0), 0),
  }));
  const maxTotal = detail.questions.reduce((sum, q) => sum + (q.rubric?.points ?? 0), 0);

  return (
    <section aria-label="回答と採点">
      <h2>回答と採点</h2>
      {detail.attempt.status === "NOT_STARTED" && <p className="muted">まだ開始していません。</p>}
      <details className="intro">
        <summary>課題の冒頭説明</summary>
        <Markdown>{detail.intro}</Markdown>
      </details>
      {detail.questions.map((q, i) => (
        <section key={q.qid} className="grade-row" aria-label={`問 ${i + 1}`}>
          <div className="grade-answer">
            <h3>問 {i + 1}</h3>
            <Markdown>{q.body}</Markdown>
            <h4>回答</h4>
            <AnswerView
              question={q}
              content={detail.answers[q.qid]?.content}
              onDownload={() => props.onDownload(q.qid)}
            />
          </div>
          <div className="grade-input">
            <h4>採点基準{q.rubric?.points !== undefined && `（${q.rubric.points} 点満点）`}</h4>
            {q.rubric?.body ? (
              <Markdown>{q.rubric.body}</Markdown>
            ) : (
              <p className="muted">（なし）</p>
            )}
            <h4>採点</h4>
            {detail.grades.length === 0 ? (
              <p className="muted">まだ採点はありません。</p>
            ) : (
              <dl className="detail">
                {detail.grades.map((g) => {
                  const item = g.items[q.qid];
                  return (
                    <div key={g.graderSub}>
                      <dt>
                        {graderName(g.graderSub)}（{gradeState(g)}）
                      </dt>
                      <dd>
                        {item?.score !== undefined ? `${item.score} 点` : "未入力"}
                        {item?.comment && <span className="comment">：{item.comment}</span>}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            )}
          </div>
        </section>
      ))}
      {totals.length > 0 && (
        <section aria-label="合計と総評">
          <h3>合計と総評</h3>
          <table className="list" aria-label="合計と総評">
            <thead>
              <tr>
                <th>採点者</th>
                <th>合計</th>
                <th>総評</th>
                <th>最終保存</th>
              </tr>
            </thead>
            <tbody>
              {totals.map(({ g, total }) => (
                <tr key={g.graderSub}>
                  <td>
                    {graderName(g.graderSub)}（{gradeState(g)}）
                  </td>
                  <td>
                    {total}
                    {maxTotal > 0 && ` / ${maxTotal}`} 点
                  </td>
                  <td className="wrap">
                    {g.overallComment || <span className="muted">なし</span>}
                  </td>
                  <td>{formatJst(g.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </section>
  );
}
