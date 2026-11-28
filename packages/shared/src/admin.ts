import type { AnswerContent, AttemptStatus } from "./attempt.js";
import type { AuditRecord } from "./audit.js";
import type { ExamDefinition, Question } from "./exam.js";
import type { AssignmentStatus, GradeItem } from "./grading.js";
import type { Role } from "./roles.js";
import type { ExamDraftDefinition } from "./schemas.js";

/**
 * 管理者 API（/api/admin/*、docs/design.md §14.6）のリクエスト・レスポンス型。
 * 管理者は候補者のメールアドレスを閲覧できる（§14.1。受験の発行・連絡に必要）。
 */

/** 一覧のページ。cursor があれば、次のページを ?cursor= で読む */
export interface AdminPage<T> {
  items: T[];
  cursor?: string;
}

export interface AdminUser {
  sub: string;
  email: string;
  name: string;
  roles: Role[];
  disabled: boolean;
  createdAt: string;
}

/** POST /api/admin/users */
export interface AdminCreateUserRequest {
  email: string;
  name: string;
  /** 候補者は ["candidate"]、それ以外は grader・admin の組み合わせ */
  roles: Role[];
}

/** 画面から付与・削除できるロール（候補者のロールは変えない） */
export type StaffRole = Exclude<Role, "candidate">;

/** PUT /api/admin/users/{sub}/roles。変更後のロール（1 つ以上） */
export interface AdminSetRolesRequest {
  roles: StaffRole[];
}

/** GET /api/admin/users */
export type AdminUserPage = AdminPage<AdminUser>;

/** GET /api/admin/audit */
export type AdminAuditPage = AdminPage<AuditRecord>;

/** 課題の下書きの要約（一覧・詳細） */
export interface AdminExamDraftInfo {
  /** 下書きの版（楽観ロック用。保存するたびに増える） */
  version: number;
  title: string;
  /** 下書きの元にした公開版（未公開なら 0） */
  baseVersion: number;
  updatedAt: string;
  updatedBy: { sub: string; name: string };
  /** この下書きの内容を公開した版（公開後に保存し直すと無くなる） */
  publishedVersion?: number;
}

/** GET /api/admin/exams の要素 */
export interface AdminExam {
  examId: string;
  /** 最新版の題名（未公開なら、作成したときの題名） */
  title: string;
  /** 最新版（未公開なら無い。未公開の課題には受験を発行できない） */
  latestVersion?: number;
  updatedAt: string;
  draft?: AdminExamDraftInfo;
}

/** GET /api/admin/exams/{examId} */
export interface AdminExamDetail {
  exam: AdminExam;
  /** 最新版の定義（未公開なら無い） */
  latest?: ExamDefinition;
  /** 下書き（無ければ無い）。定義は編集の途中の内容で、公開の検証を通るとは限らない */
  draft?: AdminExamDraftInfo & { definition: ExamDraftDefinition; problems: string[] };
  /** 公開した版の履歴（新しい順） */
  versions: { version: number; title: string; publishedAt: string }[];
}

/** PUT /api/admin/exams/{examId}/draft のリクエスト */
export interface AdminSaveDraftRequest {
  definition: ExamDraftDefinition;
  version: number;
  baseVersion: number;
  create?: boolean;
}

/** PUT /api/admin/exams/{examId}/draft のレスポンス */
export interface AdminSaveDraftResponse {
  draft: AdminExamDraftInfo;
  /** 公開の前に直すべき点（無ければ公開できる） */
  problems: string[];
}

/** POST /api/admin/exams/{examId}/publish のレスポンス */
export interface AdminPublishResponse {
  /** published: 新しい版を作った。unchanged: 最新版と同じ内容のため作らなかった */
  kind: "published" | "unchanged";
  version: number;
}

/** 受験（一覧・詳細）。status は表示上の状態（期限処理の前でも、期限を過ぎた未提出は EXPIRED） */
export interface AdminAttempt {
  attemptId: string;
  candidateSub: string;
  candidateName: string;
  examId: string;
  examVersion: number;
  examTitle: string;
  status: AttemptStatus;
  issuedAt: string;
  deadlineAt: string;
  startedAt?: string;
  submittedAt?: string;
  canceledAt?: string;
  /**
   * 採点者の割り当て数（まだ割り当てていなければ 0）。一覧・ダッシュボードでは必ず返す
   * （割り当て数を持たない既存データは、割り当ての件数を数えて補う）
   */
  assignmentCount?: number;
}

/** GET /api/admin/attempts?status=&examId=（進行中 → 提出済み以降 → 期限切れ → 取消の順） */
export type AdminAttemptPage = AdminPage<AdminAttempt>;

/** POST /api/admin/attempts */
export interface AdminIssueAttemptRequest {
  /** 候補者のメールアドレス */
  email: string;
  examId: string;
  /** 期限日（YYYY-MM-DD。その日の 23:59:59 JST まで。翌日以降） */
  deadline: string;
}

/** POST /api/admin/attempts/{attemptId}/extend */
export interface AdminExtendAttemptRequest {
  deadline: string;
}

/** POST /api/admin/attempts/{attemptId}/assign */
export interface AdminAssignRequest {
  graderEmails: string[];
}

/** POST /api/admin/attempts/{attemptId}/assign のレスポンス */
export interface AdminAssignResponse {
  attempt: AdminAttempt;
  /** 割り当てた採点者 */
  assigned: { sub: string; name: string }[];
  /** 割り当て済みだったため、何もしなかった採点者 */
  skipped: { sub: string; name: string }[];
}

export interface AdminAssignment {
  graderSub: string;
  graderName: string;
  assignedAt: string;
  status: AssignmentStatus;
  finalizedAt?: string;
}

export interface AdminGrade {
  graderSub: string;
  items: Record<string, GradeItem>;
  overallComment: string;
  updatedAt: string;
  finalizedAt?: string;
}

/** GET /api/admin/attempts/{attemptId} */
export interface AdminAttemptDetail {
  attempt: AdminAttempt;
  /** 候補者のメールアドレス（個人データを削除した後は無い） */
  candidateEmail?: string;
  intro: string;
  /** 採点基準（rubric）を含む */
  questions: Question[];
  answers: Record<string, { content: AnswerContent; updatedAt: string }>;
  assignments: AdminAssignment[];
  /** すべての採点者の採点（下書きを含む） */
  grades: AdminGrade[];
}

/** GET /api/admin/summary（ダッシュボード） */
export interface AdminSummary {
  at: string;
  counts: Record<AttemptStatus, number>;
  /** 期限が近い未着手・回答中（期限が近い順） */
  dueSoon: AdminAttempt[];
  dueSoonTotal: number;
  /** 期限が近いとみなす日数 */
  dueSoonDays: number;
  /** 提出済みで、採点者が割り当てられていない受験（提出が古い順） */
  unassigned: AdminAttempt[];
  unassignedTotal: number;
}
