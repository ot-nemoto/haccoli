import type { CandidateQuestion } from "./exam.js";
import type { AnswerContent } from "./schemas.js";

export type {
  AnswerContent,
  ChoiceAnswer,
  FileAnswer,
  SaveAnswerRequest,
  TextAnswer,
} from "./schemas.js";

/** POST .../upload-url のレスポンス。fields と file を multipart/form-data で url に POST する */
export interface UploadUrlResponse {
  url: string;
  fields: Record<string, string>;
  fileKey: string;
  maxBytes: number;
}

/** 受験ステータス（docs/design.md §6.3） */
export const ATTEMPT_STATUSES = [
  "NOT_STARTED",
  "IN_PROGRESS",
  "SUBMITTED",
  "EXPIRED",
  "GRADING",
  "GRADED",
  "CANCELED",
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const ATTEMPT_STATUS_LABELS: Record<AttemptStatus, string> = {
  NOT_STARTED: "未着手",
  IN_PROGRESS: "回答中",
  SUBMITTED: "提出済み",
  EXPIRED: "期限切れ（未提出）",
  GRADING: "提出済み",
  GRADED: "提出済み",
  CANCELED: "取消",
};

/** PUT .../answers/{qid} のレスポンス。ファイルはサーバーが求めたサイズ・SHA-256 を含む */
export interface SaveAnswerResponse {
  content: AnswerContent;
  version: number;
  updatedAt: string;
}

export interface SavedAnswer {
  content: AnswerContent;
  version: number;
  updatedAt: string;
}

/** GET /api/candidate/attempts の要素 */
export interface CandidateAttemptSummary {
  attemptId: string;
  examTitle: string;
  /** 期限到来済みで未提出なら EXPIRED（バッチ処理前でも反映する） */
  status: AttemptStatus;
  deadlineAt: string;
  issuedAt: string;
  startedAt?: string;
  submittedAt?: string;
}

/** GET /api/candidate/attempts/{attemptId} */
export interface CandidateAttemptDetail extends CandidateAttemptSummary {
  /** 冒頭説明（Markdown） */
  intro: string;
  /** 未着手の間は空（問題は開始後に表示） */
  questions: CandidateQuestion[];
  answers: Record<string, SavedAnswer>;
}

/** POST /api/candidate/attempts/{attemptId}/submit */
export interface SubmitResponse {
  submittedAt: string;
  /** 未回答だった問題（提出は受け付ける） */
  unanswered: string[];
}

/** 回答済みか（空の記述・未選択は未回答）。提出時の未回答一覧に使う */
export function isAnswered(content: AnswerContent | undefined): boolean {
  if (!content) return false;
  if ("text" in content) return content.text.trim().length > 0;
  if ("selected" in content) return content.selected.length > 0;
  if ("fileKey" in content) return content.fileKey.length > 0;
  return false;
}
