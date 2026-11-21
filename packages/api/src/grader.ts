import {
  createGraderDownloadUrl,
  finalizeGrade,
  getGraderView,
  listAssignmentsForGrader,
  saveGrade,
} from "@haccoli/core";
import type {
  DownloadUrlResponse,
  GraderAssignmentSummary,
  GraderAttemptDetail,
  SaveGradeResponse,
} from "@haccoli/shared";
import { finalizeGradeRequestSchema, saveGradeRequestSchema } from "@haccoli/shared/schemas";
import { Hono } from "hono";
import type { AppEnv } from "./auth.js";
import type { ApiDeps } from "./deps.js";
import { ApiError } from "./errors.js";

/**
 * 採点者 API（docs/design.md §7.3）。/api/grader/* に requireRole("grader") 済みでマウントする。
 * リソース単位の認可（自分に割り当てられた提出済みの受験のみ）は core が graderSub を条件にして行う。
 * レスポンスに候補者の email を含めない（氏名のみ）。
 */
export function graderRoutes(deps: ApiDeps) {
  const app = new Hono<AppEnv>();
  const invalid = () => new ApiError(400, "VALIDATION", "リクエストの形式が不正です");

  app.get("/assignments", async (c) => {
    return c.json<GraderAssignmentSummary[]>(
      await listAssignmentsForGrader(deps, c.get("user").sub),
    );
  });

  app.get("/attempts/:attemptId", async (c) => {
    const v = await getGraderView(deps, c.req.param("attemptId"), c.get("user").sub);
    return c.json<GraderAttemptDetail>({
      attemptId: v.attempt.attemptId,
      examTitle: v.attempt.examTitle,
      candidateName: v.attempt.candidateName,
      ...(v.attempt.submittedAt ? { submittedAt: v.attempt.submittedAt } : {}),
      assignmentStatus: v.assignment.status,
      intro: v.exam.intro,
      questions: v.exam.questions,
      answers: Object.fromEntries(
        v.answers.map((a) => [a.qid, { content: a.content, updatedAt: a.updatedAt }]),
      ),
      grade: {
        items: v.grade?.items ?? {},
        overallComment: v.grade?.overallComment ?? "",
        version: v.grade?.version ?? 0,
        ...(v.grade?.updatedAt ? { updatedAt: v.grade.updatedAt } : {}),
        ...(v.grade?.finalizedAt ? { finalizedAt: v.grade.finalizedAt } : {}),
      },
    });
  });

  app.post("/attempts/:attemptId/answers/:qid/download-url", async (c) => {
    const url = await createGraderDownloadUrl(deps, {
      attemptId: c.req.param("attemptId"),
      graderSub: c.get("user").sub,
      qid: c.req.param("qid"),
    });
    return c.json<DownloadUrlResponse>({ url });
  });

  app.put("/attempts/:attemptId/grade", async (c) => {
    const body = saveGradeRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) throw invalid();
    const saved = await saveGrade(deps, {
      attemptId: c.req.param("attemptId"),
      graderSub: c.get("user").sub,
      items: body.data.items,
      overallComment: body.data.overallComment,
      version: body.data.version,
    });
    return c.json<SaveGradeResponse>(saved);
  });

  app.post("/attempts/:attemptId/grade/finalize", async (c) => {
    const body = finalizeGradeRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) throw invalid();
    const res = await finalizeGrade(deps, {
      attemptId: c.req.param("attemptId"),
      graderSub: c.get("user").sub,
      version: body.data.version,
    });
    return c.json({ finalizedAt: res.finalizedAt });
  });

  return app;
}
