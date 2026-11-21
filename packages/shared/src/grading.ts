import type { AnswerContent, AttemptStatus } from "./attempt.js";
import type { Question } from "./exam.js";
import type { GradeItem } from "./schemas.js";

export type { GradeItem } from "./schemas.js";

/** 採点割り当ての状態（§6.1 Assignment） */
export const ASSIGNMENT_STATUSES = ["ASSIGNED", "DRAFT", "DONE"] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const ASSIGNMENT_STATUS_LABELS: Record<AssignmentStatus, string> = {
  ASSIGNED: "未採点",
  DRAFT: "下書き",
  DONE: "確定",
};

/** 採点者が閲覧できる受験のステータス（提出済み以降） */
export const GRADABLE_STATUSES: readonly AttemptStatus[] = ["SUBMITTED", "GRADING", "GRADED"];

/**
 * 採点者向けの型には候補者の email を含めない（§6.1）。氏名のみ。
 */

/** GET /api/grader/assignments の要素 */
export interface GraderAssignmentSummary {
  attemptId: string;
  examTitle: string;
  candidateName: string;
  submittedAt?: string;
  assignedAt: string;
  assignmentStatus: AssignmentStatus;
}

export interface GraderGrade {
  items: Record<string, GradeItem>;
  overallComment: string;
  /** 未保存なら 0 */
  version: number;
  updatedAt?: string;
  finalizedAt?: string;
}

/** GET /api/grader/attempts/{attemptId} */
export interface GraderAttemptDetail {
  attemptId: string;
  examTitle: string;
  candidateName: string;
  submittedAt?: string;
  assignmentStatus: AssignmentStatus;
  intro: string;
  /** 採点基準（rubric）を含む */
  questions: Question[];
  answers: Record<string, { content: AnswerContent; updatedAt: string }>;
  /** 自分の採点のみ（他の採点者の採点は返さない） */
  grade: GraderGrade;
}

/** PUT .../grade のレスポンス */
export interface SaveGradeResponse {
  version: number;
  updatedAt: string;
}

/** POST .../download-url のレスポンス */
export interface DownloadUrlResponse {
  url: string;
}
