import type { AttemptStatus } from "@haccoli/shared";

/** DynamoDB シングルテーブルのキー定義（docs/design.md §6.1） */
export const keys = {
  user: (sub: string) => ({ PK: `USER#${sub}`, SK: "PROFILE" }),
  userByEmail: (email: string) => ({ GSI1PK: `EMAIL#${email}`, GSI1SK: "USER" }),

  examMeta: (examId: string) => ({ PK: `EXAM#${examId}`, SK: "META" }),
  examVersion: (examId: string, version: number) => ({
    PK: `EXAM#${examId}`,
    // 文字列ソートで版順になるよう 0 埋め
    SK: `V#${String(version).padStart(6, "0")}`,
  }),

  attemptPk: (attemptId: string) => `ATTEMPT#${attemptId}`,
  attemptMeta: (attemptId: string) => ({ PK: `ATTEMPT#${attemptId}`, SK: "META" }),
  attemptsByCandidate: (sub: string, issuedAt: string) => ({
    GSI1PK: `CAND#${sub}`,
    GSI1SK: `ATTEMPT#${issuedAt}`,
  }),
  attemptsByStatus: (status: AttemptStatus, deadlineAt: string) => ({
    GSI2PK: `STATUS#${status}`,
    GSI2SK: deadlineAt,
  }),
  answer: (attemptId: string, qid: string) => ({ PK: `ATTEMPT#${attemptId}`, SK: `ANS#${qid}` }),
} as const;

export const GSI1 = "GSI1";
export const GSI2 = "GSI2";
