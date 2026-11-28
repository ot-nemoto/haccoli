import { ADMIN_ATTEMPT_STATUS_LABELS, ASSIGNMENT_STATUS_LABELS } from "@haccoli/shared";
import {
  type AssignmentRecord,
  type AttemptRecord,
  effectiveStatus,
  type GradeRecord,
  getAttemptBundle,
  listAttempts,
} from "./attempts.js";
import { type AuditDeps, writeAudit } from "./audit.js";
import { toCsv } from "./csv.js";
import { DomainError, NotFoundError } from "./errors.js";
import type { DataDeps } from "./exams.js";
import { getExamSummary, getExamVersion } from "./exams.js";
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

/** 採点結果が大きすぎて、その経路（管理画面の API）では渡せない。CLI で出力してもらう */
export class ResultsTooLargeError extends DomainError {
  constructor(reason: string) {
    super(
      `採点結果が大きすぎるため、画面から出力できません（${reason}）。CLI の result:export で出力してください`,
    );
  }
}

/** 受験ごとのデータを同時に読む数（多すぎると DynamoDB のスロットリングに当たる） */
const READ_CONCURRENCY = 10;

/**
 * 課題の採点結果を集める（docs/design.md §8 result:export）。管理者用のため候補者の email を含む。
 * 問題の列は全版の問題を版の順に並べる（版によって問題が異なる場合に備える）。
 * 監査ログは記録しないため、外には出さない（exportResultsCsv が記録してから渡す）。
 */
async function collectResults(
  deps: DataDeps,
  examId: string,
  limits: { maxAttempts?: number },
): Promise<{ questions: ResultQuestion[]; rows: ResultRow[]; attempts: number }> {
  // 課題 ID の誤りを、空の CSV（と出力の記録）にしない
  if (!(await getExamSummary(deps, examId))) {
    throw new NotFoundError(`課題が見つかりません: ${examId}`);
  }
  const attempts = (await listAttempts(deps))
    .filter((a) => a.examId === examId)
    .sort((x, y) => x.issuedAt.localeCompare(y.issuedAt));
  if (limits.maxAttempts !== undefined && attempts.length > limits.maxAttempts) {
    throw new ResultsTooLargeError(`受験が ${attempts.length} 件`);
  }

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

  // 受験ごとのデータを、同時に読む数を絞って並列に読む（順番に読むと件数に比例して遅くなる）
  const bundles = await mapLimit(attempts, READ_CONCURRENCY, (a) =>
    getAttemptBundle(deps, a.attemptId),
  );
  const subs = new Set<string>();
  for (const b of bundles) {
    if (!b) continue;
    subs.add(b.attempt.candidateSub);
    for (const a of b.assignments) subs.add(a.graderSub);
  }
  const emails = new Map(
    await mapLimit(
      [...subs],
      READ_CONCURRENCY,
      async (sub) => [sub, (await getUserBySub(deps, sub))?.email ?? ""] as const,
    ),
  );
  const emailOf = (sub: string) => emails.get(sub) ?? "";

  const now = deps.now?.() ?? new Date();
  const rows: ResultRow[] = [];
  for (const bundle of bundles) {
    if (!bundle) continue;
    const attempt = { ...bundle.attempt, status: effectiveStatus(bundle.attempt, now) };
    const candidateEmail = emailOf(attempt.candidateSub);
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
        graderEmail: emailOf(assignment.graderSub),
        ...(grade ? { grade } : {}),
      });
    }
  }
  return { questions, rows, attempts: attempts.length };
}

/**
 * 採点結果の CSV を作る（CLI の result:export と管理者 API）。個人情報を含むため、上限を確かめた
 * 後、渡す直前に監査ログに記録する（記録できなければ渡さない。§14.4・§14.7）。上限を超えて渡さない
 * 場合や、課題がない場合は記録しない。
 *
 * @param limits.maxAttempts 受験数の上限（時間の上限がある API で、読み始める前に断る）
 * @param limits.maxBytes CSV の大きさの上限（measure で測る）
 */
export async function exportResultsCsv(
  deps: DataDeps & AuditDeps,
  examId: string,
  limits: {
    maxAttempts?: number;
    maxBytes?: number;
    measure?: (csv: string) => number;
  } = {},
): Promise<{ csv: string; rows: number }> {
  const { questions, rows, attempts } = await collectResults(deps, examId, limits);
  const csv = resultsCsv(questions, rows);
  const size = (limits.measure ?? ((x: string) => Buffer.byteLength(x)))(csv);
  if (limits.maxBytes !== undefined && size > limits.maxBytes) {
    throw new ResultsTooLargeError(`${(size / 1024 / 1024).toFixed(1)} MB`);
  }
  await writeAudit(deps, {
    action: "result.export",
    target: { type: "exam", id: examId },
    detail: { attempts, rows: rows.length },
  });
  return { csv, rows: rows.length };
}

/** items を limit 件ずつ同時に処理する（結果は items の順） */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * 採点結果の CSV（CLI の result:export と管理者 API で同じ形式。docs/design.md §8）。
 * 受験 × 採点者ごとに 1 行。問題ごとの点数・コメントの列は questions の順。
 */
export function resultsCsv(questions: ResultQuestion[], rows: ResultRow[]): string {
  const header = [
    "attemptId",
    "examVersion",
    "candidateName",
    "candidateEmail",
    "attemptStatus",
    "submittedAt",
    "graderName",
    "graderEmail",
    "gradeStatus",
    "finalizedAt",
    "totalScore",
    ...questions.flatMap((q) => [
      `${q.qid}_score${q.points !== undefined ? `(/${q.points})` : ""}`,
      `${q.qid}_comment`,
    ]),
    "overallComment",
  ];
  const body = rows.map((r) => {
    const items = r.grade?.items ?? {};
    const scores = Object.values(items)
      .map((i) => i.score)
      .filter((s): s is number => s !== undefined);
    return [
      r.attempt.attemptId,
      r.attempt.examVersion,
      r.attempt.candidateName,
      r.candidateEmail,
      `${r.attempt.status}（${ADMIN_ATTEMPT_STATUS_LABELS[r.attempt.status]}）`,
      r.attempt.submittedAt,
      r.assignment?.graderName,
      r.graderEmail,
      r.assignment
        ? `${r.assignment.status}（${ASSIGNMENT_STATUS_LABELS[r.assignment.status]}）`
        : undefined,
      r.assignment?.finalizedAt,
      scores.length > 0 ? scores.reduce((a, b) => a + b, 0) : undefined,
      ...questions.flatMap((q) => [items[q.qid]?.score, items[q.qid]?.comment]),
      r.grade?.overallComment || undefined,
    ];
  });
  return toCsv([header, ...body]);
}
