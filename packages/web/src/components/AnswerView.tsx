import type { AnswerContent, Question } from "@haccoli/shared";
import { useState } from "react";
import { formatJst } from "../lib/format.js";
import { formatBytes } from "../lib/upload.js";
import { Markdown } from "./Markdown.js";

/** 採点画面での回答表示（読み取り専用） */
export function AnswerView(props: {
  question: Question;
  content?: AnswerContent;
  onDownload: () => Promise<void>;
}) {
  const { question: q, content } = props;
  const [raw, setRaw] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string>();

  if (q.type === "text") {
    const text = content && "text" in content ? content.text : "";
    if (!text.trim()) return <p className="muted">未回答</p>;
    return (
      <div className="answer-view">
        <button type="button" className="link" onClick={() => setRaw(!raw)}>
          {raw ? "整形して表示" : "原文を表示"}
        </button>
        {raw ? <pre className="raw">{text}</pre> : <Markdown>{text}</Markdown>}
        <p className="counter">{[...text].length.toLocaleString()} 文字</p>
      </div>
    );
  }

  if (q.type === "choice") {
    const selected = content && "selected" in content ? content.selected : [];
    const correct = q.rubric?.correct;
    if (selected.length === 0) return <p className="muted">未回答</p>;
    return (
      <ul className="choice-result">
        {q.options.map((o) => {
          const isSelected = selected.includes(o.id);
          const isCorrect = correct?.includes(o.id);
          return (
            <li key={o.id} className={isSelected ? "selected" : undefined}>
              {isSelected ? "☑" : "☐"} {o.label}
              {isCorrect && <span className="badge badge-correct">正解</span>}
            </li>
          );
        })}
      </ul>
    );
  }

  const file = content && "fileKey" in content && content.fileKey ? content : undefined;
  if (!file) return <p className="muted">未提出</p>;
  return (
    <div className="file-answer">
      <dl className="file-info">
        <dt>ファイル</dt>
        <dd>{file.fileName}</dd>
        <dt>サイズ</dt>
        <dd>{formatBytes(file.size)}</dd>
        <dt>SHA-256</dt>
        <dd className="hash">{file.sha256}</dd>
        <dt>アップロード</dt>
        <dd>{formatJst(file.uploadedAt)}</dd>
      </dl>
      <button
        type="button"
        className="secondary"
        disabled={downloading}
        onClick={async () => {
          setDownloading(true);
          setError(undefined);
          try {
            await props.onDownload();
          } catch {
            setError("ダウンロードできませんでした。時間をおいて再度お試しください。");
          } finally {
            setDownloading(false);
          }
        }}
      >
        {downloading ? "準備中…" : "ダウンロード"}
      </button>
      <p className="muted">
        提出物は信頼できないファイルとして扱い、隔離した環境で展開・実行してください。ダウンロード後に
        SHA-256 が一致することを確認できます。
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
