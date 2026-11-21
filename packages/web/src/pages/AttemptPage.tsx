import {
  type AnswerContent,
  type CandidateAttemptDetail,
  type CandidateAttemptSummary,
  isAnswered,
  type SaveAnswerResponse,
  type SubmitResponse,
  type UploadUrlResponse,
} from "@haccoli/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { ApiError, messageOf } from "../api.js";
import { useApi } from "../auth/useApi.js";
import { Deadline, StatusBadge } from "../components/AttemptStatus.js";
import { Markdown } from "../components/Markdown.js";
import { emptyContent, type FieldState, QuestionField } from "../components/QuestionField.js";
import { clearDraft, loadDraft, saveDraft } from "../lib/drafts.js";
import { UploadError, uploadToS3 } from "../lib/upload.js";
import { Layout } from "./Layout.js";

/** 入力が止まってから自動保存するまでの時間 */
const AUTOSAVE_DELAY_MS = 3000;

/** 課題回答画面（docs/design.md §9 /exam/:attemptId） */
export function AttemptPage() {
  const { attemptId = "" } = useParams();
  const api = useApi();
  const [detail, setDetail] = useState<CandidateAttemptDetail>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  // 再読み込みのたびに回答フォームを作り直す
  const [loadCount, setLoadCount] = useState(0);
  const now = useNow();

  const path = `/candidate/attempts/${encodeURIComponent(attemptId)}`;
  const load = useCallback(async () => {
    try {
      setDetail(await api<CandidateAttemptDetail>(path));
      setLoadCount((n) => n + 1);
      setError(undefined);
    } catch (e) {
      setError(messageOf(e));
    }
  }, [api, path]);

  useEffect(() => {
    void load();
  }, [load]);

  const [starting, setStarting] = useState(false);
  const start = async () => {
    setStarting(true);
    setNotice(undefined);
    try {
      await api<CandidateAttemptSummary>(`${path}/start`, { method: "POST" });
      await load();
    } catch (e) {
      setNotice(messageOf(e));
      await load();
    } finally {
      setStarting(false);
    }
  };

  // 画面を開いたまま期限を過ぎたら、サーバーの判定を待たずに入力を止める
  const expiredNow = detail ? new Date(detail.deadlineAt) <= now : false;
  const status = detail && expiredNow && isOpen(detail.status) ? "EXPIRED" : detail?.status;

  return (
    <Layout userRole="candidate">
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!detail && !error && <p>読み込み中…</p>}
      {detail && status && (
        <>
          <div className="attempt-header">
            <h1>{detail.examTitle}</h1>
            <div>
              <StatusBadge status={status} />{" "}
              <Deadline deadlineAt={detail.deadlineAt} status={status} now={now} />
            </div>
          </div>
          {notice && (
            <p role="alert" className="error">
              {notice}
            </p>
          )}
          <Markdown>{detail.intro}</Markdown>

          {status === "NOT_STARTED" && (
            <div className="start">
              <p>「開始」を押すと問題が表示されます。期限までは何度でも中断・再開できます。</p>
              <button type="button" onClick={start} disabled={starting}>
                {starting ? "開始しています…" : "開始する"}
              </button>
            </div>
          )}
          {status === "EXPIRED" && !detail.startedAt && (
            <p className="muted">受験期限を過ぎたため、この課題には回答できません。</p>
          )}
          {status === "CANCELED" && <p className="muted">この受験は取り消されました。</p>}

          {detail.questions.length > 0 && (
            <AnswerForm
              key={loadCount}
              attemptId={attemptId}
              detail={detail}
              readOnly={status !== "IN_PROGRESS"}
              onStateChanged={async (message) => {
                setNotice(message);
                await load();
              }}
              onReload={load}
            />
          )}
        </>
      )}
    </Layout>
  );
}

function AnswerForm(props: {
  attemptId: string;
  detail: CandidateAttemptDetail;
  readOnly: boolean;
  onStateChanged: (message: string) => Promise<void>;
  onReload: () => Promise<void>;
}) {
  const { attemptId, detail, readOnly, onStateChanged } = props;
  const api = useApi();
  const navigate = useNavigate();
  const path = `/candidate/attempts/${encodeURIComponent(attemptId)}`;

  const [fields, setFields] = useState<Record<string, FieldState>>(() =>
    initialFields(attemptId, detail, readOnly),
  );
  // 非同期処理（タイマー・保存完了）から最新の状態を読むための参照
  const fieldsRef = useRef(fields);
  useEffect(() => {
    fieldsRef.current = fields;
  }, [fields]);

  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const inflight = useRef(new Set<string>());
  const pending = useRef(new Set<string>());

  const patch = useCallback(
    (qid: string, update: Partial<FieldState>) =>
      setFields((prev) => {
        const cur = prev[qid];
        return cur ? { ...prev, [qid]: { ...cur, ...update } } : prev;
      }),
    [],
  );

  const save = useCallback(
    async (qid: string): Promise<void> => {
      // 同じ問題の保存は直列化する（古い版で送って競合扱いになるのを防ぐ）
      if (inflight.current.has(qid)) {
        pending.current.add(qid);
        return;
      }
      const f = fieldsRef.current[qid];
      if (!f?.dirty || f.conflict) return;
      inflight.current.add(qid);
      const sent = f.content;
      patch(qid, { saving: true, error: undefined });
      try {
        const res = await api<SaveAnswerResponse>(`${path}/answers/${encodeURIComponent(qid)}`, {
          method: "PUT",
          body: JSON.stringify({ content: sent, version: f.version }),
        });
        setFields((prev) => {
          const cur = prev[qid];
          if (!cur) return prev;
          // 保存中にさらに入力された場合は未保存のまま残す
          const stillDirty = cur.content !== sent;
          if (stillDirty)
            saveDraft(attemptId, qid, { content: cur.content, baseVersion: res.version });
          else clearDraft(attemptId, qid);
          return {
            ...prev,
            [qid]: {
              ...cur,
              version: res.version,
              savedAt: res.updatedAt,
              saving: false,
              dirty: stillDirty,
            },
          };
        });
        const latest = fieldsRef.current[qid] as FieldState;
        fieldsRef.current = {
          ...fieldsRef.current,
          [qid]: { ...latest, version: res.version, dirty: latest.content !== sent },
        };
      } catch (e) {
        if (e instanceof ApiError && e.code === "VERSION_CONFLICT") {
          patch(qid, { saving: false, conflict: true, error: e.message });
        } else if (e instanceof ApiError && e.code === "INVALID_STATE") {
          patch(qid, { saving: false });
          await onStateChanged(e.message);
        } else {
          patch(qid, { saving: false, error: messageOf(e) });
        }
      } finally {
        inflight.current.delete(qid);
        if (pending.current.delete(qid)) void save(qid);
      }
    },
    [api, path, attemptId, onStateChanged, patch],
  );

  /** ファイル提出: 署名付き POST を受け取り S3 へ直接送ってから、回答として登録する */
  const uploadFile = async (qid: string, file: File) => {
    const q = detail.questions.find((x) => x.qid === qid);
    const cur = fieldsRef.current[qid];
    if (q?.type !== "file" || !cur || readOnly) return;
    if (!/\.zip$/i.test(file.name)) {
      patch(qid, { error: "zip ファイル（.zip）を選択してください" });
      return;
    }
    if (file.size === 0) {
      patch(qid, { error: "空のファイルは提出できません" });
      return;
    }
    if (file.size > q.file.maxSizeMB * 1024 * 1024) {
      patch(qid, { error: `ファイルが大きすぎます（上限 ${q.file.maxSizeMB}MB）` });
      return;
    }
    patch(qid, { uploading: 0, error: undefined });
    const base = `${path}/answers/${encodeURIComponent(qid)}`;
    try {
      const target = await api<UploadUrlResponse>(`${base}/upload-url`, {
        method: "POST",
        body: JSON.stringify({ fileName: file.name, size: file.size }),
      });
      await uploadToS3(target, file, (percent) => patch(qid, { uploading: percent }));
      patch(qid, { uploading: undefined, saving: true });
      const res = await api<SaveAnswerResponse>(base, {
        method: "PUT",
        body: JSON.stringify({
          content: { fileKey: target.fileKey, fileName: file.name },
          version: fieldsRef.current[qid]?.version ?? cur.version,
        }),
      });
      const next = { content: res.content, version: res.version, savedAt: res.updatedAt };
      fieldsRef.current = {
        ...fieldsRef.current,
        [qid]: { ...(fieldsRef.current[qid] as FieldState), ...next },
      };
      patch(qid, { ...next, saving: false, dirty: false });
    } catch (e) {
      const update = { uploading: undefined, saving: false };
      if (e instanceof ApiError && e.code === "VERSION_CONFLICT") {
        patch(qid, { ...update, conflict: true, error: e.message });
      } else if (e instanceof ApiError && e.code === "INVALID_STATE") {
        patch(qid, update);
        await onStateChanged(e.message);
      } else {
        patch(qid, { ...update, error: e instanceof UploadError ? e.message : messageOf(e) });
      }
    }
  };

  const onChange = (qid: string, content: AnswerContent) => {
    const cur = fieldsRef.current[qid];
    if (!cur || readOnly) return;
    const next = { ...cur, content, dirty: true };
    fieldsRef.current = { ...fieldsRef.current, [qid]: next };
    setFields((prev) => ({
      ...prev,
      [qid]: { ...(prev[qid] as FieldState), content, dirty: true },
    }));
    saveDraft(attemptId, qid, { content, baseVersion: cur.version });
    const t = timers.current.get(qid);
    if (t) clearTimeout(t);
    timers.current.set(
      qid,
      setTimeout(() => void save(qid), AUTOSAVE_DELAY_MS),
    );
  };

  const saveAll = useCallback(async () => {
    for (const t of timers.current.values()) clearTimeout(t);
    timers.current.clear();
    await Promise.all(
      Object.entries(fieldsRef.current)
        .filter(([, f]) => f.dirty)
        .map(([qid]) => save(qid)),
    );
  }, [save]);

  // 退避した未保存入力を復元した場合は、すぐ保存する
  useEffect(() => {
    if (!readOnly && Object.values(fieldsRef.current).some((f) => f.dirty)) void saveAll();
  }, [readOnly, saveAll]);

  // 未保存の変更があるままページを離れようとしたら警告する
  const hasUnsaved = Object.values(fields).some(
    (f) => f.dirty || f.saving || f.uploading !== undefined,
  );
  useEffect(() => {
    if (!hasUnsaved) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasUnsaved]);

  useEffect(() => {
    const t = timers.current;
    return () => {
      for (const timer of t.values()) clearTimeout(timer);
    };
  }, []);

  // ---- 提出 ----
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const unanswered = useMemo(
    () =>
      detail.questions
        .map((q, i) => ({ qid: q.qid, label: `問 ${i + 1}` }))
        .filter((q) => !isAnswered(fields[q.qid]?.content)),
    [detail.questions, fields],
  );

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      await saveAll();
      const blocked = Object.values(fieldsRef.current).some(
        (f) => f.dirty || f.error || f.conflict || f.uploading !== undefined,
      );
      if (blocked) {
        setSubmitError("保存できていない回答があります。表示されているエラーを確認してください。");
        return;
      }
      await api<SubmitResponse>(`${path}/submit`, { method: "POST" });
      for (const q of detail.questions) clearDraft(attemptId, q.qid);
      navigate(`/exam/${attemptId}/done`, { replace: true });
    } catch (e) {
      if (e instanceof ApiError && e.code === "INVALID_STATE") {
        await onStateChanged(e.message);
      } else {
        setSubmitError(messageOf(e));
      }
    } finally {
      setSubmitting(false);
      setConfirming(false);
    }
  };

  return (
    <div className="answer-form">
      {detail.questions.map((q, i) => {
        const field = fields[q.qid];
        if (!field) return null;
        return (
          <QuestionField
            key={q.qid}
            index={i}
            question={q}
            field={field}
            readOnly={readOnly}
            onChange={(content) => onChange(q.qid, content)}
            onUpload={(file) => void uploadFile(q.qid, file)}
            onReload={() => void props.onReload()}
          />
        );
      })}

      {!readOnly && (
        <div className="actions">
          <button
            type="button"
            className="secondary"
            onClick={() => void saveAll()}
            disabled={!hasUnsaved || submitting}
          >
            すべて保存
          </button>
          {!confirming ? (
            <button type="button" onClick={() => setConfirming(true)} disabled={submitting}>
              提出する
            </button>
          ) : (
            <div className="confirm" role="dialog" aria-label="提出の確認">
              <p>
                <strong>提出すると回答を変更できなくなります。</strong>
              </p>
              {unanswered.length > 0 && (
                <p className="error">
                  未回答の問題があります: {unanswered.map((u) => u.label).join("、")}
                </p>
              )}
              <button type="button" onClick={() => void submit()} disabled={submitting}>
                {submitting ? "提出しています…" : "提出する"}
              </button>{" "}
              <button
                type="button"
                className="secondary"
                onClick={() => setConfirming(false)}
                disabled={submitting}
              >
                戻る
              </button>
            </div>
          )}
          {submitError && (
            <p role="alert" className="error">
              {submitError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function initialFields(
  attemptId: string,
  detail: CandidateAttemptDetail,
  readOnly: boolean,
): Record<string, FieldState> {
  return Object.fromEntries(
    detail.questions.map((q) => {
      const saved = detail.answers[q.qid];
      const version = saved?.version ?? 0;
      const base: FieldState = {
        content: saved?.content ?? emptyContent(q),
        version,
        dirty: false,
        saving: false,
        ...(saved ? { savedAt: saved.updatedAt } : {}),
      };
      const draft = readOnly ? undefined : loadDraft(attemptId, q.qid);
      if (draft && draft.baseVersion === version) {
        return [q.qid, { ...base, content: draft.content, dirty: true }];
      }
      // 別の画面で保存が進んでいる（版が違う）退避データは使わない
      if (draft || readOnly) clearDraft(attemptId, q.qid);
      return [q.qid, base];
    }),
  );
}

function isOpen(status: string) {
  return status === "NOT_STARTED" || status === "IN_PROGRESS";
}

/** 残り時間表示のため 30 秒ごとに再描画する */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}
