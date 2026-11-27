import {
  type AssignmentRecord,
  type AttemptRecord,
  effectiveStatus,
  type GradeRecord,
  getAttemptBundle,
  listAttempts,
} from "./attempts.js";
import { type AuditDeps, writeAudit } from "./audit.js";
import type { DataDeps } from "./exams.js";
import { getExamVersion } from "./exams.js";
import { getUserBySub } from "./users.js";

export interface ResultQuestion {
  qid: string;
  points?: number;
}

/** 採点結果の 1 行（受験 × 採点者。未割り当ての受験は採点者なしで 1 行） */
export interface ResultRow {
  attempt: AttemptRecord;
  candidateEmail: string;
  assignment?: AssignmentRecord;
  graderEmail?: string;
  grade?: GradeRecord;
}

/**
 * 課題の採点結果を集める（docs/design.md §8 result:export）。管理者用のため候補者の email を含む。
 * 問題の列は全版の問題を版の順に並べる（版によって問題が異なる場合に備える）。
 * 個人情報を含むため、渡す前に監査ログに記録する（記録できなければ渡さない。§14.4・§14.7）。
 */
export async function collectResults(
  deps: DataDeps & AuditDeps,
  examId: string,
): Promise<{ questions: ResultQuestion[]; rows: ResultRow[] }> {
  const attempts = (await listAttempts(deps)).filter((a) => a.examId === examId);

  const questions: ResultQuestion[] = [];
  const versions = [...new Set(attempts.map((a) => a.examVersion))].sort((a, b) => a - b);
  for (const v of versions) {
    const exam = await getExamVersion(deps, examId, v);
    for (const q of exam?.questions ?? []) {
      if (!questions.some((x) => x.qid === q.qid)) {
        questions.push({
          qid: q.qid,
          ...(q.rubric?.points !== undefined ? { points: q.rubric.points } : {}),
        });
      }
    }
  }

  const emails = new Map<string, string>();
  const emailOf = async (sub: string) => {
    if (!emails.has(sub)) emails.set(sub, (await getUserBySub(deps, sub))?.email ?? "");
    return emails.get(sub) ?? "";
  };

  const now = deps.now?.() ?? new Date();
  const rows: ResultRow[] = [];
  for (const a of attempts.sort((x, y) => x.issuedAt.localeCompare(y.issuedAt))) {
    const bundle = await getAttemptBundle(deps, a.attemptId);
    if (!bundle) continue;
    const attempt = { ...bundle.attempt, status: effectiveStatus(bundle.attempt, now) };
    const candidateEmail = await emailOf(attempt.candidateSub);
    if (bundle.assignments.length === 0) {
      rows.push({ attempt, candidateEmail });
      continue;
    }
    for (const assignment of bundle.assignments) {
      const grade = bundle.grades.find((g) => g.graderSub === assignment.graderSub);
      rows.push({
        attempt,
        candidateEmail,
        assignment,
        graderEmail: await emailOf(assignment.graderSub),
        ...(grade ? { grade } : {}),
      });
    }
  }
  await writeAudit(deps, {
    action: "result.export",
    target: { type: "exam", id: examId },
    detail: { attempts: attempts.length, rows: rows.length },
  });
  return { questions, rows };
}
