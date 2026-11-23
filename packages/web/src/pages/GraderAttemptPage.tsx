import {
  ASSIGNMENT_STATUS_LABELS,
  type DownloadUrlResponse,
  type GradeItem,
  type GraderAttemptDetail,
  type SaveGradeResponse,
} from "@haccoli/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { ApiError, messageOf } from "../api.js";
import { useApi } from "../auth/useApi.js";
import { AnswerView } from "../components/AnswerView.js";
import { Markdown } from "../components/Markdown.js";
import { formatJst, formatJstTime } from "../lib/format.js";
import { scoreError } from "../lib/grading.js";
import { Layout } from "./Layout.js";

const AUTOSAVE_DELAY_MS = 3000;

interface Draft {
  items: Record<string, GradeItem>;
  overallComment: string;
}

/** 採点画面（docs/design.md §9 /grader/:attemptId） */
export function GraderAttemptPage() {
  const { attemptId = "" } = useParams();
  const api = useApi();
  const path = `/grader/attempts/${encodeURIComponent(attemptId)}`;
  const [detail, setDetail] = useState<GraderAttemptDetail>();
  const [loadError, setLoadError] = useState<string>();
  const [loadCount, setLoadCount] = useState(0);

  const load = useCallback(async () => {
    try {
      setDetail(await api<GraderAttemptDetail>(path));
      setLoadCount((n) => n + 1);
      setLoadError(undefined);
    } catch (e) {
      setLoadError(messageOf(e));
    }
  }, [api, path]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Layout userRole="grader">
      {loadError && (
        <p role="alert" className="error">
          {loadError}
        </p>
      )}
      {!detail && !loadError && <p>読み込み中…</p>}
      {detail && <GradingForm key={loadCount} detail={detail} path={path} onReload={load} />}
    </Layout>
  );
}

function GradingForm(props: {
  detail: GraderAttemptDetail;
  path: string;
  onReload: () => Promise<void>;
}) {
  const { detail, path } = props;
  const api = useApi();
  const [draft, setDraft] = useState<Draft>({
    items: detail.grade.items,
    overallComment: detail.grade.overallComment,
  });
  const [version, setVersion] = useState(detail.grade.version);
  const [savedAt, setSavedAt] = useState(detail.grade.updatedAt);
  const [finalizedAt, setFinalizedAt] = useState(detail.grade.finalizedAt);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const readOnly = Boolean(finalizedAt) || detail.assignmentStatus === "DONE";

  // 非同期処理から最新の値を読むための参照
  const latest = useRef({ draft, version, dirty });
  latest.current = { draft, version, dirty };
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inflight = useRef<Promise<boolean> | undefined>(undefined);

  /** 点数が不正な問題の表示名（「問 2」など） */
  const invalidLabels = useCallback(
    (d: Draft) =>
      detail.questions
        .map((q, i) => ({ q, label: `問 ${i + 1}` }))
        .filter(({ q }) => scoreError(d.items[q.qid]?.score, q.rubric?.points))
        .map(({ label }) => label),
    [detail.questions],
  );

  /** 保存する。成功（または保存不要）なら true */
  const save = useCallback(async (): Promise<boolean> => {
    if (inflight.current) await inflight.current;
    if (!latest.current.dirty) return true;
    const sent = latest.current.draft;
    const invalid = invalidLabels(sent);
    if (invalid.length > 0) {
      setError(`点数の入力に誤りがあります（${invalid.join("、")}）。修正すると保存されます。`);
      return false;
    }
    const run = (async () => {
      setSaving(true);
      setError(undefined);
      try {
        const res = await api<SaveGradeResponse>(`${path}/grade`, {
          method: "PUT",
          body: JSON.stringify({ ...sent, version: latest.current.version }),
        });
        latest.current.version = res.version;
        setVersion(res.version);
        setSavedAt(res.updatedAt);
        // 保存中にさらに入力された場合は未保存のまま残す
        const stillDirty = latest.current.draft !== sent;
        latest.current.dirty = stillDirty;
        setDirty(stillDirty);
        return !stillDirty;
      } catch (e) {
        if (e instanceof ApiError && e.code === "VERSION_CONFLICT") setConflict(true);
        setError(messageOf(e));
        return false;
      } finally {
        setSaving(false);
      }
    })();
    inflight.current = run;
    try {
      return await run;
    } finally {
      inflight.current = undefined;
    }
  }, [api, path, invalidLabels]);

  const update = (next: Draft) => {
    if (readOnly || conflict) return;
    latest.current = { ...latest.current, draft: next, dirty: true };
    setDraft(next);
    setDirty(true);
    if (timer.current) clearTimeout(timer.current);
    if (invalidLabels(next).length > 0) return; // 不正な入力は保存しない（欄の下に表示する）
    setError(undefined);
    timer.current = setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
  };

  const setItem = (qid: string, patch: Partial<GradeItem>) => {
    const cur = draft.items[qid] ?? {};
    const merged: GradeItem = { ...cur, ...patch };
    if (merged.score === undefined) delete merged.score;
    if (!merged.comment) delete merged.comment;
    update({ ...draft, items: { ...draft.items, [qid]: merged } });
  };

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!dirty && !saving) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty, saving]);

  // ---- 確定 ----
  const [confirming, setConfirming] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const unscored = detail.questions
    .map((q, i) => ({ qid: q.qid, label: `問 ${i + 1}` }))
    .filter((q) => draft.items[q.qid]?.score === undefined);
  const invalidNow = invalidLabels(draft);
  const total = detail.questions.reduce((sum, q) => sum + (draft.items[q.qid]?.score ?? 0), 0);
  const maxTotal = detail.questions.reduce((sum, q) => sum + (q.rubric?.points ?? 0), 0);

  const finalize = async () => {
    setFinalizing(true);
    setError(undefined);
    try {
      clearTimeout(timer.current);
      // 一度も保存していない場合も確定できるよう、先に保存する
      if (latest.current.version === 0) latest.current.dirty = true;
      // 失敗時は確認欄を開いたままにし、その中にエラーを表示する
      if (!(await save())) return;
      const res = await api<{ finalizedAt: string }>(`${path}/grade/finalize`, {
        method: "POST",
        body: JSON.stringify({ version: latest.current.version }),
      });
      setFinalizedAt(res.finalizedAt);
      setConfirming(false);
    } catch (e) {
      if (e instanceof ApiError && e.code === "VERSION_CONFLICT") setConflict(true);
      setError(messageOf(e));
    } finally {
      setFinalizing(false);
    }
  };

  const errorView = error && (
    <p role="alert" className="error">
      {error}{" "}
      {conflict && (
        <button type="button" className="link" onClick={() => void props.onReload()}>
          再読み込み
        </button>
      )}
    </p>
  );

  const status = finalizedAt ? "DONE" : detail.assignmentStatus;
  return (
    <div className="grading">
      <div className="attempt-header">
        <h1>
          {detail.candidateName} さん ／ {detail.examTitle}
        </h1>
        <div>
          <span className={`badge badge-assign-${status.toLowerCase()}`}>
            {ASSIGNMENT_STATUS_LABELS[status]}
          </span>{" "}
          {detail.submittedAt && (
            <span className="deadline">提出 {formatJst(detail.submittedAt)}</span>
          )}{" "}
          <span className="deadline">
            合計 {total}
            {maxTotal > 0 && ` / ${maxTotal}`} 点
          </span>{" "}
          <span className="save-status">
            {finalizedAt
              ? `確定済み（${formatJst(finalizedAt)}）`
              : saving
                ? "保存中…"
                : invalidNow.length > 0
                  ? "入力に誤りがあります（未保存）"
                  : dirty
                    ? "未保存の変更があります"
                    : savedAt
                      ? `下書き保存済み（${formatJstTime(savedAt)}）`
                      : "未保存"}
          </span>
        </div>
        {/* 見出しは画面上部に固定されるため、どこまでスクロールしていてもエラーが見える */}
        {!confirming && errorView}
      </div>

      {finalizedAt && (
        <p className="notice">
          採点を確定しました。<Link to="/grader">担当一覧へ戻る</Link>
        </p>
      )}

      <details className="intro">
        <summary>課題の冒頭説明</summary>
        <Markdown>{detail.intro}</Markdown>
      </details>

      {detail.questions.map((q, i) => {
        const item = draft.items[q.qid] ?? {};
        const itemError = scoreError(item.score, q.rubric?.points);
        return (
          <section key={q.qid} className="grade-row">
            <div className="grade-answer">
              <h2>問 {i + 1}</h2>
              <Markdown>{q.body}</Markdown>
              <h3>回答</h3>
              <AnswerView
                question={q}
                content={detail.answers[q.qid]?.content}
                onDownload={async () => {
                  const res = await api<DownloadUrlResponse>(
                    `${path}/answers/${encodeURIComponent(q.qid)}/download-url`,
                    { method: "POST" },
                  );
                  window.location.assign(res.url);
                }}
              />
            </div>
            <div className="grade-input">
              <h3>採点基準</h3>
              {q.rubric?.body ? (
                <Markdown>{q.rubric.body}</Markdown>
              ) : (
                <p className="muted">（なし）</p>
              )}
              <label>
                点数{q.rubric?.points !== undefined && `（${q.rubric.points} 点満点）`}
                <input
                  type="number"
                  min={0}
                  max={q.rubric?.points}
                  step="any"
                  inputMode="decimal"
                  value={item.score ?? ""}
                  readOnly={readOnly}
                  aria-invalid={itemError ? true : undefined}
                  onChange={(e) => {
                    const v = e.target.value;
                    setItem(q.qid, { score: v === "" ? undefined : Number(v) });
                  }}
                />
              </label>
              {itemError && <p className="error">{itemError}</p>}
              <label>
                コメント
                <textarea
                  rows={4}
                  value={item.comment ?? ""}
                  readOnly={readOnly}
                  onChange={(e) => setItem(q.qid, { comment: e.target.value })}
                />
              </label>
            </div>
          </section>
        );
      })}

      <section className="question">
        <label>
          総評
          <textarea
            rows={5}
            value={draft.overallComment}
            readOnly={readOnly}
            onChange={(e) => update({ ...draft, overallComment: e.target.value })}
          />
        </label>
      </section>

      {!readOnly && (
        <div className="actions">
          <button
            type="button"
            className="secondary"
            onClick={() => {
              clearTimeout(timer.current);
              void save();
            }}
            disabled={!dirty || saving || conflict}
          >
            下書き保存
          </button>
          {!confirming ? (
            <button
              type="button"
              onClick={() => {
                setError(undefined);
                setConfirming(true);
              }}
              disabled={finalizing || conflict}
            >
              採点を確定する
            </button>
          ) : (
            <div className="confirm" role="dialog" aria-label="採点の確定">
              <p>
                <strong>確定すると採点を変更できなくなります。</strong>
              </p>
              {invalidNow.length > 0 && (
                <p className="error">点数の入力に誤りがあります: {invalidNow.join("、")}</p>
              )}
              {unscored.length > 0 && (
                <p className="error">
                  点数が未入力の問題があります: {unscored.map((u) => u.label).join("、")}
                </p>
              )}
              {errorView}
              <button
                type="button"
                onClick={() => void finalize()}
                disabled={finalizing || invalidNow.length > 0}
              >
                {finalizing ? "確定しています…" : "確定する"}
              </button>{" "}
              <button
                type="button"
                className="secondary"
                onClick={() => setConfirming(false)}
                disabled={finalizing}
              >
                戻る
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
