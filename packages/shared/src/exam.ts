import type { ChoiceQuestion, FileQuestion, Question, TextQuestion } from "./schemas.js";

export type {
  ChoiceQuestion,
  DraftQuestion,
  ExamDefinition,
  ExamDraftDefinition,
  FileQuestion,
  Question,
  Rubric,
  TextQuestion,
} from "./schemas.js";

/** 候補者に見せる問題（rubric を除外した型。フィールドを明示的に選んで組み立てる） */
export type CandidateQuestion =
  | Pick<TextQuestion, "qid" | "type" | "body" | "maxLength">
  | Pick<ChoiceQuestion, "qid" | "type" | "body" | "multiple" | "options">
  | Pick<FileQuestion, "qid" | "type" | "body" | "file">;

export function toCandidateQuestion(q: Question): CandidateQuestion {
  switch (q.type) {
    case "text":
      return { qid: q.qid, type: q.type, body: q.body, maxLength: q.maxLength };
    case "choice":
      return {
        qid: q.qid,
        type: q.type,
        body: q.body,
        multiple: q.multiple,
        options: q.options.map((o) => ({ id: o.id, label: o.label })),
      };
    case "file":
      return { qid: q.qid, type: q.type, body: q.body, file: { ...q.file } };
  }
}
