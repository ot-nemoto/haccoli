import type {
  AdminExamDetail,
  AdminPublishResponse,
  AdminSaveDraftRequest,
  AdminSaveDraftResponse,
  DraftQuestion,
  ExamDraftDefinition,
} from "@haccoli/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { ApiError, messageOf } from "../api.js";
import { useApi } from "../auth/useApi.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { Markdown } from "../components/Markdown.js";
import { emptyContent, QuestionField } from "../components/QuestionField.js";
import { useUnsavedChanges } from "../hooks/useUnsavedChanges.js";
import {
  draftState,
  move,
  newQuestion,
  nextOptionId,
  previewQuestion,
  QUESTION_TYPE_LABELS,
  type QuestionType,
  toDraft,
  withType,
} from "../lib/examDraft.js";
import { formatJst } from "../lib/format.js";
import { AdminLayout } from "./AdminLayout.js";

/** 課題の編集（docs/design.md §14.7 /admin/exams/:examId） */
export function AdminExamPage() {
  const { examId = "" } = useParams();
  const api = useApi();
  const path = `/admin/exams/${encodeURIComponent(examId)}`;
  const [detail, setDetail] = useState<AdminExamDetail>();
  const [error, setError] = useState<string>();
  /**
   * 編集の状態を作り直す回数。公開・作り直し・競合の後の明示的な読み直しでだけ増やす
   * （最初の読み込みが重なっても〈StrictMode など〉、操作中の状態〈プレビュー・確認〉を消さない）
   */
  const [editorKey, setEditorKey] = useState(0);
  /** 通知は画面で持つ（公開の後に読み直して、編集の状態を作り直しても残す） */
  const [notice, setNotice] = useState<string>();
  /** 最後に出した読み込み。古い応答で新しい表示を上書きしない */
  const latest = useRef(0);

  const fetchDetail = useCallback(async () => {
    const id = ++latest.current;
    try {
      const d = await api<AdminExamDetail>(path);
      if (id !== latest.current) return false;
      setDetail(d);
      setError(undefined);
      return true;
    } catch (e) {
      if (id === latest.current) setError(messageOf(e));
      return false;
    }
  }, [api, path]);

  useEffect(() => {
    void fetchDetail();
  }, [fetchDetail]);

  /** 明示的に読み直し、編集の状態を作り直す（保存していない変更は捨てる） */
  const reload = useCallback(async () => {
    if (await fetchDetail()) setEditorKey((n) => n + 1);
  }, [fetchDetail]);

  return (
    <AdminLayout>
      <p>
        <Link to="/admin/exams">課題の一覧へ</Link>
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!detail && !error && <p>読み込み中…</p>}
      {detail && (
        <Editor
          key={editorKey}
          detail={detail}
          path={path}
          notice={notice}
          onNotice={setNotice}
          onReload={reload}
        />
      )}
    </AdminLayout>
  );
}

function Editor(props: {
  detail: AdminExamDetail;
  path: string;
  notice?: string;
  onNotice: (notice: string | undefined) => void;
  onReload: () => Promise<void>;
}) {
  const { detail, path } = props;
  const api = useApi();
  // 下書きがあれば下書きから、無ければ最新版から編集を始める
  const [def, setDef] = useState<ExamDraftDefinition>(() =>
    detail.draft
      ? detail.draft.definition
      : detail.latest
        ? toDraft(detail.latest)
        : { examId: detail.exam.examId, title: detail.exam.title, intro: "", questions: [] },
  );
  const [version, setVersion] = useState(detail.draft?.version ?? 0);
  const [problems, setProblems] = useState(detail.draft?.problems ?? []);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const { notice, onNotice: setNotice } = props;
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [confirming, setConfirming] = useState<"publish" | "rebase">();
  useUnsavedChanges(dirty);

  const latest = detail.exam.latestVersion;
  const stale = draftState(detail.exam) === "stale";
  const update = (next: ExamDraftDefinition) => {
    setDef(next);
    setDirty(true);
    setNotice(undefined);
  };
  const updateQuestion = (i: number, q: DraftQuestion) =>
    update({ ...def, questions: def.questions.map((x, j) => (j === i ? q : x)) });

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.code === "VERSION_CONFLICT") setConflict(true);
    setError(messageOf(e));
  };

  const save = async (opts: { rebase?: boolean; definition?: ExamDraftDefinition } = {}) => {
    setBusy(true);
    setError(undefined);
    try {
      const body: AdminSaveDraftRequest = {
        definition: opts.definition ?? def,
        version,
        ...(opts.rebase ? { rebase: true } : {}),
      };
      const res = await api<AdminSaveDraftResponse>(`${path}/draft`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      setVersion(res.draft.version);
      setProblems(res.problems);
      setDirty(false);
      if (opts.rebase) {
        // 元にした版が変わったので、一覧・警告の表示のために読み直す
        await props.onReload();
        return;
      }
      setNotice(
        res.problems.length > 0
          ? "下書きを保存しました。公開の前に、下の点を直してください。"
          : "下書きを保存しました。",
      );
      return true;
    } catch (e) {
      fail(e);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await api<AdminPublishResponse>(`${path}/publish`, {
        method: "POST",
        body: JSON.stringify({ version }),
      });
      setConfirming(undefined);
      setNotice(
        res.kind === "published"
          ? `v${res.version} として公開しました。この後に発行する受験から使われます。`
          : `最新版（v${res.version}）と同じ内容のため、新しい版は作りませんでした。`,
      );
      await props.onReload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const canPublish = !dirty && !stale && problems.length === 0 && version > 0;

  return (
    <div className="exam-editor">
      <h1>
        {def.title || detail.exam.title} <span className="muted">{detail.exam.examId}</span>
      </h1>
      <p className="muted">
        最新版：{latest !== undefined ? `v${latest}` : "未公開"}
        {detail.draft &&
          ` ／ 下書きの保存：${formatJst(detail.draft.updatedAt)}（${detail.draft.updatedBy.name}）`}
      </p>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      {stale && (
        <div className="notice warning" role="alert">
          この下書きは v{detail.draft?.baseVersion} を元にしていますが、その後に v{latest}{" "}
          が公開されました（CLI
          での投入など）。このままでは公開できません。最新版の内容を確かめ、下書きを作り直してください。
          <p>
            <button type="button" className="secondary" onClick={() => setConfirming("rebase")}>
              最新版から作り直す
            </button>
          </p>
        </div>
      )}
      {confirming === "rebase" && (
        <ConfirmDialog
          title="最新版から作り直す"
          confirmLabel="作り直す"
          busy={busy}
          onConfirm={() => {
            if (!detail.latest) return;
            const next = toDraft(detail.latest);
            setDef(next);
            void save({ rebase: true, definition: next }).then(() => setConfirming(undefined));
          }}
          onCancel={() => setConfirming(undefined)}
        >
          下書きの内容を、最新版（v{latest}）の内容で置き換えます。
          <strong>下書きで編集した内容は失われます。</strong>
        </ConfirmDialog>
      )}

      <div className="toolbar editor-actions">
        <div className="segmented" role="tablist" aria-label="表示">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "edit"}
            className={mode === "edit" ? "" : "secondary"}
            onClick={() => setMode("edit")}
          >
            編集
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "preview"}
            className={mode === "preview" ? "" : "secondary"}
            onClick={() => setMode("preview")}
          >
            プレビュー
          </button>
        </div>
        <button type="button" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? "保存中…" : "下書きを保存"}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy || !canPublish}
          onClick={() => setConfirming("publish")}
        >
          公開する
        </button>
        <span className="save-status">
          {dirty ? "保存していない変更があります" : version > 0 ? "保存済み" : "下書きなし"}
        </span>
      </div>
      {!canPublish && !stale && (
        <p className="muted">
          {dirty || version === 0
            ? "公開するには、先に下書きを保存してください。"
            : problems.length > 0
              ? "公開するには、下の点を直して保存してください。"
              : ""}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}{" "}
          {conflict && (
            <button type="button" className="link" onClick={() => void props.onReload()}>
              再読み込み（この画面の変更は失われます）
            </button>
          )}
        </p>
      )}
      {confirming === "publish" && (
        <ConfirmDialog
          title="課題の公開"
          confirmLabel="公開する"
          busy={busy}
          onConfirm={() => void publish()}
          onCancel={() => setConfirming(undefined)}
        >
          下書きの内容を、新しい版（v{(latest ?? 0) + 1}
          ）として公開します。この後に発行する受験から使われます。発行済みの受験は、発行したときの版のままです。
          <strong>公開した版は取り消せません。</strong>
        </ConfirmDialog>
      )}

      {problems.length > 0 && (
        <section className="panel wide-panel problems" aria-label="公開の前に直すべき点">
          <h2>公開の前に直すべき点</h2>
          <ul>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </section>
      )}

      {mode === "edit" ? (
        <DefinitionForm def={def} onChange={update} onQuestion={updateQuestion} />
      ) : (
        <Preview def={def} />
      )}

      <section aria-label="版の履歴">
        <h2>版の履歴</h2>
        {detail.versions.length === 0 ? (
          <p>まだ公開していません。</p>
        ) : (
          <table className="list" aria-label="版の履歴">
            <thead>
              <tr>
                <th>版</th>
                <th>題名</th>
                <th>公開日時</th>
              </tr>
            </thead>
            <tbody>
              {detail.versions.map((v) => (
                <tr key={v.version}>
                  <td>v{v.version}</td>
                  <td className="wrap">{v.title}</td>
                  <td>{formatJst(v.publishedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function DefinitionForm(props: {
  def: ExamDraftDefinition;
  onChange: (def: ExamDraftDefinition) => void;
  onQuestion: (i: number, q: DraftQuestion) => void;
}) {
  const { def } = props;
  const [addType, setAddType] = useState<QuestionType>("text");
  const qids = def.questions.map((q) => q.qid);
  return (
    <form aria-label="課題の編集" onSubmit={(e) => e.preventDefault()}>
      <section className="panel wide-panel">
        <label>
          題名
          <input
            value={def.title}
            maxLength={200}
            onChange={(e) => props.onChange({ ...def, title: e.target.value })}
          />
        </label>
        <label>
          冒頭説明（Markdown）
          <textarea
            rows={6}
            value={def.intro}
            onChange={(e) => props.onChange({ ...def, intro: e.target.value })}
          />
        </label>
      </section>

      {def.questions.map((q, i) => (
        <QuestionEditor
          // biome-ignore lint/suspicious/noArrayIndexKey: 部品は状態を持たない（すべて親の値）。ID を key にすると、ID の入力中に作り直されて入力欄から外れる
          key={i}
          index={i}
          count={def.questions.length}
          question={q}
          otherQids={qids.filter((_, j) => j !== i)}
          onChange={(next) => props.onQuestion(i, next)}
          onMove={(delta) => props.onChange({ ...def, questions: move(def.questions, i, delta) })}
          onRemove={() =>
            props.onChange({ ...def, questions: def.questions.filter((_, j) => j !== i) })
          }
        />
      ))}

      <div className="toolbar">
        <label className="inline">
          回答形式
          <select value={addType} onChange={(e) => setAddType(e.target.value as QuestionType)}>
            {(Object.keys(QUESTION_TYPE_LABELS) as QuestionType[]).map((t) => (
              <option key={t} value={t}>
                {QUESTION_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="secondary"
          onClick={() =>
            props.onChange({ ...def, questions: [...def.questions, newQuestion(addType, qids)] })
          }
        >
          問題を追加
        </button>
      </div>
    </form>
  );
}

function QuestionEditor(props: {
  index: number;
  count: number;
  question: DraftQuestion;
  otherQids: string[];
  onChange: (q: DraftQuestion) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const { question: q, index: i } = props;
  const set = (patch: Partial<DraftQuestion>) => props.onChange({ ...q, ...patch });
  const setRubric = (patch: NonNullable<DraftQuestion["rubric"]>) => {
    const rubric = { ...q.rubric, ...patch };
    for (const k of Object.keys(rubric) as (keyof typeof rubric)[]) {
      if (rubric[k] === undefined) delete rubric[k];
    }
    const { rubric: _, ...rest } = q;
    props.onChange(Object.keys(rubric).length > 0 ? { ...rest, rubric } : rest);
  };
  const label = `問 ${i + 1}`;
  const options = q.options ?? [];
  const correct = q.rubric?.correct ?? [];
  const num = (v: string) => (v === "" ? undefined : Number(v));

  return (
    <section className="panel wide-panel question-editor" aria-label={label}>
      <div className="question-editor-header">
        <h2>{label}</h2>
        <div className="row-actions">
          <button
            type="button"
            className="link"
            disabled={i === 0}
            onClick={() => props.onMove(-1)}
          >
            上へ
          </button>
          <button
            type="button"
            className="link"
            disabled={i === props.count - 1}
            onClick={() => props.onMove(1)}
          >
            下へ
          </button>
          <button type="button" className="link danger-link" onClick={props.onRemove}>
            削除
          </button>
        </div>
      </div>
      <div className="inline-fields">
        <label>
          回答形式
          <select
            value={q.type}
            onChange={(e) => props.onChange(withType(q, e.target.value as QuestionType))}
          >
            {(Object.keys(QUESTION_TYPE_LABELS) as QuestionType[]).map((t) => (
              <option key={t} value={t}>
                {QUESTION_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <label>
          問題 ID
          <input
            value={q.qid}
            maxLength={63}
            aria-invalid={props.otherQids.includes(q.qid) ? true : undefined}
            onChange={(e) => set({ qid: e.target.value })}
          />
        </label>
        {q.type === "text" && (
          <label>
            最大文字数
            <input
              type="number"
              min={1}
              max={100_000}
              value={q.maxLength ?? ""}
              onChange={(e) => set({ maxLength: num(e.target.value) })}
            />
          </label>
        )}
        {q.type === "file" && (
          <label>
            最大サイズ（MB）
            <input
              type="number"
              min={1}
              max={20}
              value={q.file?.maxSizeMB ?? ""}
              onChange={(e) => set({ file: { ...q.file, maxSizeMB: num(e.target.value) } })}
            />
          </label>
        )}
        <label>
          配点
          <input
            type="number"
            min={0}
            step="any"
            value={q.rubric?.points ?? ""}
            onChange={(e) => setRubric({ points: num(e.target.value) })}
          />
        </label>
      </div>
      <label>
        問題文（Markdown）
        <textarea rows={6} value={q.body} onChange={(e) => set({ body: e.target.value })} />
      </label>

      {q.type === "choice" && (
        <fieldset className="options-editor">
          <legend>選択肢</legend>
          <label className="inline">
            <input
              type="checkbox"
              checked={q.multiple ?? false}
              onChange={(e) => set({ multiple: e.target.checked })}
            />
            複数選択できる
          </label>
          <table className="list" aria-label={`${label} の選択肢`}>
            <thead>
              <tr>
                <th>ID</th>
                <th>表示</th>
                <th>正解</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {options.map((o, j) => (
                <tr
                  // biome-ignore lint/suspicious/noArrayIndexKey: 部品は状態を持たない（すべて親の値）。ID を key にすると、ID の入力中に作り直されて入力欄から外れる
                  key={j}
                >
                  <td>
                    <input
                      aria-label={`選択肢 ${j + 1} の ID`}
                      value={o.id}
                      maxLength={63}
                      size={6}
                      onChange={(e) => {
                        const id = e.target.value;
                        set({ options: options.map((x, k) => (k === j ? { ...x, id } : x)) });
                      }}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`選択肢 ${j + 1} の表示`}
                      value={o.label}
                      maxLength={1_000}
                      onChange={(e) => {
                        const v = e.target.value;
                        set({ options: options.map((x, k) => (k === j ? { ...x, label: v } : x)) });
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`選択肢 ${j + 1} は正解`}
                      checked={correct.includes(o.id)}
                      onChange={(e) =>
                        setRubric({
                          correct: e.target.checked
                            ? [...correct, o.id]
                            : correct.filter((c) => c !== o.id),
                        })
                      }
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="link danger-link"
                      onClick={() => {
                        set({ options: options.filter((_, k) => k !== j) });
                      }}
                    >
                      削除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            <button
              type="button"
              className="secondary"
              onClick={() =>
                set({
                  options: [...options, { id: nextOptionId(options.map((o) => o.id)), label: "" }],
                })
              }
            >
              選択肢を追加
            </button>
          </p>
        </fieldset>
      )}

      <label>
        採点基準（Markdown。採点者だけに表示）
        <textarea
          rows={4}
          value={q.rubric?.body ?? ""}
          onChange={(e) => setRubric({ body: e.target.value || undefined })}
        />
      </label>
    </section>
  );
}

/** 候補者の画面と同じ表示（問題文・回答欄）と、採点者に見せる採点基準 */
function Preview(props: { def: ExamDraftDefinition }) {
  const { def } = props;
  return (
    <section aria-label="プレビュー" className="exam-preview">
      <p className="muted">
        候補者の画面と同じ表示です（回答はできません）。採点基準は採点者の画面にだけ表示されます。
      </p>
      <h2>{def.title}</h2>
      <Markdown>{def.intro}</Markdown>
      {def.questions.map((q, i) => {
        const cq = previewQuestion(q);
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: 部品は状態を持たない（すべて親の値）。ID を key にすると、ID の入力中に作り直されて入力欄から外れる
            key={i}
            className="grade-row"
          >
            <div className="grade-answer">
              <h3>問 {i + 1}</h3>
              <QuestionField
                index={i}
                question={cq}
                field={{ content: emptyContent(cq), version: 0, dirty: false, saving: false }}
                readOnly
                onChange={() => undefined}
                onUpload={() => undefined}
                onReload={() => undefined}
              />
            </div>
            <div className="grade-input">
              <h4>採点基準{q.rubric?.points !== undefined && `（${q.rubric.points} 点満点）`}</h4>
              {q.rubric?.body ? (
                <Markdown>{q.rubric.body}</Markdown>
              ) : (
                <p className="muted">（なし）</p>
              )}
              {q.type === "choice" && (
                <p>
                  正解：
                  {(q.rubric?.correct ?? [])
                    .map((c) => q.options?.find((o) => o.id === c)?.label || c)
                    .join("・") || "（指定なし）"}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}
