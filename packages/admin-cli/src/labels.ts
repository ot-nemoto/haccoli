import { ATTEMPT_STATUS_LABELS, type AttemptStatus } from "@haccoli/shared";

/** 管理者向けのステータス表示（候補者向けの表示では採点中・採点完了も「提出済み」になるため区別する） */
export const ADMIN_STATUS_LABELS: Record<AttemptStatus, string> = {
  ...ATTEMPT_STATUS_LABELS,
  GRADING: "採点中",
  GRADED: "採点完了",
};
