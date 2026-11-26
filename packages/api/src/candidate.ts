import {
  type AttemptRecord,
  createUploadUrl,
  effectiveStatus,
  getAttemptExam,
  getOwnAttemptBundle,
  listAttemptsByCandidate,
  saveAnswer,
  startAttempt,
  submitAttempt,
} from "@haccoli/core";
import {
  type CandidateAttemptDetail,
  type CandidateAttemptSummary,
  type SaveAnswerResponse,
  type SavedAnswer,
  type SubmitResponse,
  toCandidateQuestion,
  type UploadUrlResponse,
} from "@haccoli/shared";
import { saveAnswerRequestSchema, uploadUrlRequestSchema } from "@haccoli/shared/schemas";
import { Hono } from "hono";
import type { AppEnv } from "./auth.js";
import type { ApiDeps } from "./deps.js";
import { invalidRequest } from "./errors.js";

/**
 * 候補者 API（docs/design.md §7.2）。/api/candidate/* に requireRole("candidate") 済みでマウントする。
 * リソース単位の認可（本人の受験のみ）は core の各関数が candidateSub を条件にして行う。
 */
export function candidateRoutes(deps: ApiDeps) {
  const app = new Hono<AppEnv>();
  const now = () => deps.now?.() ?? new Date();

  app.get("/attempts", async (c) => {
    const attempts = await listAttemptsByCandidate(deps, c.get("user").sub);
    return c.json<CandidateAttemptSummary[]>(attempts.map((a) => toSummary(a, now())));
  });

  app.get("/attempts/:attemptId", async (c) => {
    const { attempt, answers } = await getOwnAttemptBundle(
      deps,
      c.req.param("attemptId"),
      c.get("user").sub,
    );
    const exam = await getAttemptExam(deps, attempt);
    // 問題は開始後に表示する（開始前は冒頭説明のみ）
    const started = Boolean(attempt.startedAt);
    return c.json<CandidateAttemptDetail>({
      ...toSummary(attempt, now()),
      intro: exam.intro,
      questions: started ? exam.questions.map(toCandidateQuestion) : [],
      answers: started
        ? Object.fromEntries(
            answers.map((a) => [
              a.qid,
              {
                content: a.content,
                version: a.version,
                updatedAt: a.updatedAt,
              } satisfies SavedAnswer,
            ]),
          )
        : {},
    });
  });

  app.post("/attempts/:attemptId/start", async (c) => {
    const attempt = await startAttempt(deps, c.req.param("attemptId"), c.get("user").sub);
    return c.json<CandidateAttemptSummary>(toSummary(attempt, now()));
  });

  app.put("/attempts/:attemptId/answers/:qid", async (c) => {
    const body = saveAnswerRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) throw invalidRequest(body.error);
    const saved = await saveAnswer(deps, {
      attemptId: c.req.param("attemptId"),
      candidateSub: c.get("user").sub,
      qid: c.req.param("qid"),
      content: body.data.content,
      version: body.data.version,
    });
    return c.json<SaveAnswerResponse>(saved);
  });

  app.post("/attempts/:attemptId/answers/:qid/upload-url", async (c) => {
    const body = uploadUrlRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) throw invalidRequest(body.error);
    const res = await createUploadUrl(deps, {
      attemptId: c.req.param("attemptId"),
      candidateSub: c.get("user").sub,
      qid: c.req.param("qid"),
      fileName: body.data.fileName,
      size: body.data.size,
    });
    return c.json<UploadUrlResponse>(res);
  });

  app.post("/attempts/:attemptId/submit", async (c) => {
    const { attempt, unanswered } = await submitAttempt(
      deps,
      c.req.param("attemptId"),
      c.get("user").sub,
    );
    return c.json<SubmitResponse>({ submittedAt: attempt.submittedAt ?? "", unanswered });
  });

  return app;
}

function toSummary(a: AttemptRecord, now: Date): CandidateAttemptSummary {
  return {
    attemptId: a.attemptId,
    examTitle: a.examTitle,
    status: effectiveStatus(a, now),
    deadlineAt: a.deadlineAt,
    issuedAt: a.issuedAt,
    ...(a.startedAt ? { startedAt: a.startedAt } : {}),
    ...(a.submittedAt ? { submittedAt: a.submittedAt } : {}),
  };
}
