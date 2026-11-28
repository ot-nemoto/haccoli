import type {
  AdminExam,
  CandidateQuestion,
  DraftQuestion,
  ExamDefinition,
  ExamDraftDefinition,
} from "@haccoli/shared";

/** 課題の編集画面の計算（docs/design.md §14.5・§14.7） */

export type QuestionType = DraftQuestion["type"];

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  text: "記述",
  choice: "選択",
  file: "ファイル（zip）",
};

/** 公開時の既定値（packages/shared の examDefinitionSchema と同じ） */
const DEFAULT_MAX_LENGTH = 20_000;
const DEFAULT_MAX_SIZE_MB = 20;

/** 公開済みの版を、下書きの形にする（編集の出発点） */
export function toDraft(def: ExamDefinition): ExamDraftDefinition {
  return structuredClone(def) as ExamDraftDefinition;
}

/** 新しい課題の最初の下書き */
export function emptyDraft(examId: string, title: string): ExamDraftDefinition {
  return { examId, title, intro: "", questions: [newQuestion("text", [])] };
}

/** まだ使われていない qid（q1, q2, …） */
export function nextQid(used: readonly string[]): string {
  for (let n = used.length + 1; ; n++) {
    const qid = `q${n}`;
    if (!used.includes(qid)) return qid;
  }
}

export function newQuestion(type: QuestionType, used: readonly string[]): DraftQuestion {
  return withType({ qid: nextQid(used), type, body: "" }, type);
}

/**
 * 回答形式を変える。その形式で使わない項目（選択肢・最大文字数など）は消し、使う項目は既定値で補う。
 * 問題文・採点基準の本文と配点は残す（選択式の正解だけは消す）
 */
export function withType(q: DraftQuestion, type: QuestionType): DraftQuestion {
  const { maxLength, multiple, options, file, rubric, ...rest } = q;
  const keepRubric = rubric
    ? (({ correct, ...r }) => (type === "choice" ? { ...r, ...(correct ? { correct } : {}) } : r))(
        rubric,
      )
    : undefined;
  const base = {
    ...rest,
    type,
    ...(keepRubric && Object.keys(keepRubric).length > 0 ? { rubric: keepRubric } : {}),
  };
  switch (type) {
    case "text":
      return { ...base, maxLength: maxLength ?? DEFAULT_MAX_LENGTH };
    case "choice":
      return {
        ...base,
        multiple: multiple ?? false,
        options: options ?? [
          { id: "a", label: "" },
          { id: "b", label: "" },
        ],
      };
    case "file":
      return { ...base, file: { maxSizeMB: file?.maxSizeMB ?? DEFAULT_MAX_SIZE_MB } };
  }
}

/** まだ使われていない選択肢の id（a, b, …, z, a2, …） */
export function nextOptionId(used: readonly string[]): string {
  for (let n = 0; ; n++) {
    const letter = String.fromCharCode(97 + (n % 26));
    const id = n < 26 ? letter : `${letter}${Math.floor(n / 26) + 1}`;
    if (!used.includes(id)) return id;
  }
}

/** 配列の i 番目を delta だけ動かす（範囲外なら動かさない） */
export function move<T>(list: readonly T[], i: number, delta: number): T[] {
  const j = i + delta;
  if (j < 0 || j >= list.length) return [...list];
  const next = [...list];
  [next[i], next[j]] = [next[j] as T, next[i] as T];
  return next;
}

/** プレビュー用の、候補者に見せる問題（未入力の項目は公開時の既定値で補う） */
export function previewQuestion(q: DraftQuestion): CandidateQuestion {
  switch (q.type) {
    case "text":
      return {
        qid: q.qid,
        type: "text",
        body: q.body,
        maxLength: q.maxLength ?? DEFAULT_MAX_LENGTH,
      };
    case "choice":
      return {
        qid: q.qid,
        type: "choice",
        body: q.body,
        multiple: q.multiple ?? false,
        options: (q.options ?? []).map((o) => ({ id: o.id, label: o.label })),
      };
    case "file":
      return {
        qid: q.qid,
        type: "file",
        body: q.body,
        file: { maxSizeMB: q.file?.maxSizeMB ?? DEFAULT_MAX_SIZE_MB, extensions: [".zip"] },
      };
  }
}

export type DraftState =
  /** 下書きなし（最新版のまま） */
  | "none"
  /** 下書きの内容を公開済み（最新版と同じ） */
  | "published"
  /** 公開していない変更がある */
  | "unpublished"
  /** 下書きの元にした版より新しい版が公開されている（このままでは公開できない） */
  | "stale";

export function draftState(exam: Pick<AdminExam, "latestVersion" | "draft">): DraftState {
  const d = exam.draft;
  if (!d) return "none";
  if (d.baseVersion !== (exam.latestVersion ?? 0)) return "stale";
  if (d.publishedVersion !== undefined && d.publishedVersion === exam.latestVersion) {
    return "published";
  }
  return "unpublished";
}

export const DRAFT_STATE_LABELS: Record<DraftState, string> = {
  none: "なし",
  published: "公開済み",
  unpublished: "公開していない変更あり",
  stale: "元にした版より新しい版あり",
};

/** 課題 ID の形（packages/shared の examDefinitionSchema と同じ） */
export const EXAM_ID_PATTERN = "[a-z0-9][a-z0-9\\-]{0,62}";
