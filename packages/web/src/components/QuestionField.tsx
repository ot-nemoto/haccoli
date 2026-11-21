import type { AnswerContent, CandidateQuestion, FileAnswer } from "@haccoli/shared";
import { useState } from "react";
import { formatJst, formatJstTime } from "../lib/format.js";
import { formatBytes } from "../lib/upload.js";
import { Markdown } from "./Markdown.js";

export interface FieldState {
  content: AnswerContent;
  /** サーバーに保存済みの版（未保存なら 0） */
  version: number;
  dirty: boolean;
  saving: boolean;
  savedAt?: string;
  error?: string;
  /** 別の画面で更新された。再読み込みするまで保存しない */
  conflict?: boolean;
  /** ファイルのアップロード進捗（0〜100）。アップロード中のみ */
  uploading?: number;
}

export function emptyContent(q: CandidateQuestion): AnswerContent {
  switch (q.type) {
    case "choice":
      return { selected: [] };
    case "file":
      return { fileKey: "", fileName: "", size: 0, sha256: "", uploadedAt: "" };
    default:
      return { text: "" };
  }
}

/** 問題 1 問分（問題文・回答欄・保存状態） */
export function QuestionField(props: {
  index: number;
  question: CandidateQuestion;
  field: FieldState;
  readOnly: boolean;
  onChange: (content: AnswerContent) => void;
  onUpload: (file: File) => void;
  onReload: () => void;
}) {
  const { question: q, field } = props;
  return (
    <section className="question" id={`q-${q.qid}`}>
      <Markdown>{q.body}</Markdown>
      {q.type === "text" && "text" in field.content && (
        <TextAnswer
          value={field.content.text}
          maxLength={q.maxLength}
          readOnly={props.readOnly}
          label={`問 ${props.index + 1} の回答`}
          onChange={(text) => props.onChange({ text })}
        />
      )}
      {q.type === "choice" && "selected" in field.content && (
        <fieldset className="choices" disabled={props.readOnly}>
          <legend>{q.multiple ? "当てはまるものをすべて選択" : "1 つ選択"}</legend>
          {q.options.map((o) => {
            const selected = field.content as { selected: string[] };
            const checked = selected.selected.includes(o.id);
            return (
              <label key={o.id} className="choice">
                <input
                  type={q.multiple ? "checkbox" : "radio"}
                  name={`q-${q.qid}`}
                  checked={checked}
                  onChange={() => {
                    const next = q.multiple
                      ? checked
                        ? selected.selected.filter((s) => s !== o.id)
                        : [...selected.selected, o.id]
                      : [o.id];
                    // 選択肢の定義順にそろえる
                    props.onChange({
                      selected: q.options.map((x) => x.id).filter((id) => next.includes(id)),
                    });
                  }}
                />
                {o.label}
              </label>
            );
          })}
        </fieldset>
      )}
      {q.type === "file" && "fileKey" in field.content && (
        <FileAnswerField
          value={field.content}
          maxSizeMB={q.file.maxSizeMB}
          readOnly={props.readOnly}
          uploading={field.uploading}
          onSelect={props.onUpload}
        />
      )}
      {!props.readOnly && <SaveStatus field={field} onReload={props.onReload} />}
    </section>
  );
}

function TextAnswer(props: {
  value: string;
  maxLength: number;
  readOnly: boolean;
  label: string;
  onChange: (text: string) => void;
}) {
  const [preview, setPreview] = useState(false);
  const length = [...props.value].length;
  const over = length > props.maxLength;
  return (
    <div className="text-answer">
      <div className="tabs">
        <button
          type="button"
          className={preview ? "tab" : "tab active"}
          onClick={() => setPreview(false)}
        >
          {props.readOnly ? "原文" : "編集"}
        </button>
        <button
          type="button"
          className={preview ? "tab active" : "tab"}
          onClick={() => setPreview(true)}
        >
          プレビュー
        </button>
      </div>
      {preview ? (
        <div className="preview">
          {props.value.trim() ? (
            <Markdown>{props.value}</Markdown>
          ) : (
            <p className="muted">（未入力）</p>
          )}
        </div>
      ) : (
        <textarea
          aria-label={props.label}
          value={props.value}
          readOnly={props.readOnly}
          rows={12}
          onChange={(e) => props.onChange(e.target.value)}
        />
      )}
      <div className={over ? "counter error" : "counter"}>
        {length.toLocaleString()} / {props.maxLength.toLocaleString()} 文字（Markdown 可）
      </div>
    </div>
  );
}

function SaveStatus(props: { field: FieldState; onReload: () => void }) {
  const f = props.field;
  if (f.conflict) {
    return (
      <p role="alert" className="error">
        {f.error}{" "}
        <button type="button" className="link" onClick={props.onReload}>
          再読み込み
        </button>
      </p>
    );
  }
  if (f.error) {
    return (
      <p role="alert" className="error">
        保存に失敗しました: {f.error}（入力内容はこのタブに一時保存されています）
      </p>
    );
  }
  let text = "未保存";
  if (f.uploading !== undefined) text = `アップロード中…（${f.uploading}%）`;
  else if (f.saving) text = "保存中…";
  else if (f.dirty) text = "未保存の変更があります";
  else if (f.savedAt) text = `保存済み（${formatJstTime(f.savedAt)}）`;
  else if (f.version === 0) text = "未回答";
  return <p className="save-status">{text}</p>;
}

function FileAnswerField(props: {
  value: FileAnswer;
  maxSizeMB: number;
  readOnly: boolean;
  uploading?: number;
  onSelect: (file: File) => void;
}) {
  const v = props.value;
  const busy = props.uploading !== undefined;
  return (
    <div className="file-answer">
      {v.fileKey ? (
        <dl className="file-info">
          <dt>ファイル</dt>
          <dd>{v.fileName}</dd>
          <dt>サイズ</dt>
          <dd>{formatBytes(v.size)}</dd>
          <dt>SHA-256</dt>
          <dd className="hash">{v.sha256}</dd>
          <dt>アップロード</dt>
          <dd>{formatJst(v.uploadedAt)}</dd>
        </dl>
      ) : (
        <p className="muted">まだファイルを提出していません。</p>
      )}
      {!props.readOnly && (
        <>
          <label className="file-select">
            {v.fileKey ? "別のファイルに差し替える" : "zip ファイルを選択"}（{props.maxSizeMB}MB
            まで）
            <input
              type="file"
              accept=".zip,application/zip"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) props.onSelect(file);
              }}
            />
          </label>
          {busy && (
            <progress max={100} value={props.uploading}>
              {props.uploading}%
            </progress>
          )}
          <p className="muted">
            node_modules・ビルド成果物・パスワードなどの秘密情報は含めないでください。
          </p>
        </>
      )}
    </div>
  );
}
