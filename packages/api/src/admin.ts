import {
  type AttemptRecord,
  type AuditedUserDeps,
  assignGraders,
  auditMonth,
  cancelAttempt,
  createAdminDownloadUrl,
  DUE_SOON_DAYS,
  disableUser,
  exportResultsCsv,
  extendAttempt,
  getAdminAttemptView,
  isAuditAction,
  isRole,
  issueAttempt,
  listAttemptPage,
  listAuditLogPage,
  listExams,
  listUserPage,
  registerUser,
  setStaffRoles,
  summarizeAttempts,
  type UserProfile,
} from "@haccoli/core";
import {
  type AdminAssignResponse,
  type AdminAttempt,
  type AdminAttemptDetail,
  type AdminAttemptPage,
  type AdminAuditPage,
  type AdminExam,
  type AdminSummary,
  type AdminUser,
  type AdminUserPage,
  ATTEMPT_STATUSES,
  type AttemptStatus,
  type DownloadUrlResponse,
} from "@haccoli/shared";
import {
  adminAssignRequestSchema,
  adminCreateUserRequestSchema,
  adminExtendAttemptRequestSchema,
  adminIssueAttemptRequestSchema,
  adminSetRolesRequestSchema,
} from "@haccoli/shared/schemas";
import { type Context, Hono } from "hono";
import type { AppEnv } from "./auth.js";
import type { AdminApiDeps } from "./deps.js";
import { invalidRequest } from "./errors.js";

/**
 * 管理者 API（docs/design.md §14.6）。/api/admin/* に requireRole("admin") 済みでマウントする。
 * 業務ルール（最後の管理者の保護・ロールの組み合わせなど）と監査ログの記録は core で行う。
 * 実行者は認可済みの管理者（sub・氏名）として core に渡す。
 *
 * 利用者と監査ログは Step 7-3、受験は Step 8-2、採点結果は Step 8-3。課題の API は Step 9 で追加する。
 */
export function adminRoutes(deps: AdminApiDeps) {
  const app = new Hono<AppEnv>();

  /** 監査ログに記録する実行者（§14.4） */
  const as = (c: Context<AppEnv>): AuditedUserDeps => {
    const { sub, name } = c.get("user");
    return { ...deps, actor: { type: "admin", sub, name } };
  };

  app.get("/users", async (c) => {
    const role = c.req.query("role");
    if (role !== undefined && !isRole(role)) throw invalidRequest();
    const page = await listUserPage(deps, {
      role,
      limit: limitOf(c.req.query("limit")),
      cursor: c.req.query("cursor"),
    });
    return c.json<AdminUserPage>({ ...page, items: page.items.map(toAdminUser) });
  });

  app.post("/users", async (c) => {
    const body = adminCreateUserRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) throw invalidRequest(body.error);
    const user = await registerUser(as(c), body.data);
    return c.json<AdminUser>(toAdminUser(user), 201);
  });

  /**
   * 採点者・管理者のロールを、指定した組み合わせにする。付与を先に、削除を後に行い、
   * それぞれ監査ログに記録する。admin を外すときの保護は、付与の前に確かめる（core の setStaffRoles）
   */
  app.put("/users/:sub/roles", async (c) => {
    const body = adminSetRolesRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) throw invalidRequest(body.error);
    const user = await setStaffRoles(as(c), { sub: c.req.param("sub"), roles: body.data.roles });
    return c.json<AdminUser>(toAdminUser(user));
  });

  app.post("/users/:sub/disable", async (c) => {
    const user = await disableUser(as(c), { sub: c.req.param("sub") });
    return c.json<AdminUser>(toAdminUser(user));
  });

  /** 監査ログ。month は YYYY-MM（省略時は今月、JST） */
  app.get("/audit", async (c) => {
    const month = c.req.query("month");
    if (month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw invalidRequest();
    const action = c.req.query("action");
    if (action !== undefined && !isAuditAction(action)) throw invalidRequest();
    const page = await listAuditLogPage(deps, {
      month: month ? month.replace("-", "") : auditMonth(deps.now?.() ?? new Date()),
      action,
      limit: limitOf(c.req.query("limit")),
      cursor: c.req.query("cursor"),
    });
    return c.json<AdminAuditPage>(page);
  });

  // ---- 課題・受験（Step 8-2） ----

  /** 課題の一覧（受験の発行・絞り込みに使う） */
  app.get("/exams", async (c) => {
    const exams = await listExams(deps);
    return c.json<AdminExam[]>(
      exams.map((e) => ({
        examId: e.examId,
        title: e.title,
        latestVersion: e.latestVersion,
        updatedAt: e.updatedAt,
      })),
    );
  });

  /** ダッシュボード：状態ごとの件数、期限が近い受験、採点者が未割り当ての提出 */
  app.get("/summary", async (c) => {
    const s = await summarizeAttempts(deps);
    return c.json<AdminSummary>({
      at: s.at,
      counts: s.counts,
      dueSoon: s.dueSoon.map(toAdminAttempt),
      dueSoonTotal: s.dueSoonTotal,
      dueSoonDays: DUE_SOON_DAYS,
      unassigned: s.unassigned.map(toAdminAttempt),
      unassignedTotal: s.unassignedTotal,
    });
  });

  /** 受験の一覧。status は表示上の状態（期限を過ぎた未提出は EXPIRED） */
  app.get("/attempts", async (c) => {
    const status = c.req.query("status");
    if (status !== undefined && !ATTEMPT_STATUSES.includes(status as AttemptStatus)) {
      throw invalidRequest();
    }
    const examId = c.req.query("examId");
    if (examId !== undefined && (examId.length === 0 || examId.length > 100)) {
      throw invalidRequest();
    }
    const page = await listAttemptPage(deps, {
      status: status as AttemptStatus | undefined,
      examId,
      limit: limitOf(c.req.query("limit")),
      cursor: c.req.query("cursor"),
    });
    return c.json<AdminAttemptPage>({ ...page, items: page.items.map(toAdminAttempt) });
  });

  /** 受験の発行（attempt:issue と同じ。期限は翌日以降） */
  app.post("/attempts", async (c) => {
    const body = adminIssueAttemptRequestSchema.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!body.success) throw invalidRequest(body.error);
    const attempt = await issueAttempt(as(c), body.data);
    return c.json<AdminAttempt>(toAdminAttempt(attempt), 201);
  });

  app.get("/attempts/:attemptId", async (c) => {
    const v = await getAdminAttemptView(deps, c.req.param("attemptId"));
    return c.json<AdminAttemptDetail>({
      attempt: toAdminAttempt(v.attempt),
      ...(v.candidate ? { candidateEmail: v.candidate.email } : {}),
      intro: v.exam.intro,
      questions: v.exam.questions,
      answers: Object.fromEntries(
        v.answers.map((a) => [a.qid, { content: a.content, updatedAt: a.updatedAt }]),
      ),
      assignments: v.assignments.map((a) => ({
        graderSub: a.graderSub,
        graderName: a.graderName,
        assignedAt: a.assignedAt,
        status: a.status,
        ...(a.finalizedAt ? { finalizedAt: a.finalizedAt } : {}),
      })),
      grades: v.grades.map((g) => ({
        graderSub: g.graderSub,
        items: g.items,
        overallComment: g.overallComment,
        updatedAt: g.updatedAt,
        ...(g.finalizedAt ? { finalizedAt: g.finalizedAt } : {}),
      })),
    });
  });

  /** 期限の変更（attempt:extend と同じ。期限切れからも戻せる。期限は翌日以降） */
  app.post("/attempts/:attemptId/extend", async (c) => {
    const body = adminExtendAttemptRequestSchema.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!body.success) throw invalidRequest(body.error);
    const { after } = await extendAttempt(as(c), {
      attemptId: c.req.param("attemptId"),
      deadline: body.data.deadline,
    });
    return c.json<AdminAttempt>(toAdminAttempt(after));
  });

  /** 取消（attempt:cancel と同じ。未着手・回答中のみ） */
  app.post("/attempts/:attemptId/cancel", async (c) => {
    const { after } = await cancelAttempt(as(c), { attemptId: c.req.param("attemptId") });
    return c.json<AdminAttempt>(toAdminAttempt(after));
  });

  /** 採点者の割り当て（attempt:assign と同じ。割り当て済みの採点者は skipped） */
  app.post("/attempts/:attemptId/assign", async (c) => {
    const body = adminAssignRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) throw invalidRequest(body.error);
    const r = await assignGraders(as(c), {
      attemptId: c.req.param("attemptId"),
      graderEmails: body.data.graderEmails,
    });
    const brief = (u: UserProfile) => ({ sub: u.sub, name: u.name });
    return c.json<AdminAssignResponse>({
      attempt: toAdminAttempt(r.attempt),
      assigned: r.assigned.map(brief),
      skipped: r.skipped.map(brief),
    });
  });

  app.post("/attempts/:attemptId/answers/:qid/download-url", async (c) => {
    const url = await createAdminDownloadUrl(deps, {
      attemptId: c.req.param("attemptId"),
      qid: c.req.param("qid"),
    });
    return c.json<DownloadUrlResponse>({ url });
  });

  // ---- 採点結果（Step 8-3） ----

  /**
   * 採点結果の CSV（CLI の result:export と同じ形式）。候補者・採点者の個人情報を含むため、
   * 渡す直前に監査ログに管理者として記録する（core の exportResultsCsv。記録できなければ返さない）。
   * Lambda の時間・応答の大きさの上限があるため、上限を超える課題は 413 にして CLI を案内する
   * （上限を超えて返さなかった場合は記録しない）
   */
  app.get("/exams/:examId/results.csv", async (c) => {
    const examId = c.req.param("examId");
    const { csv } = await exportResultsCsv(as(c), examId, {
      maxAttempts: MAX_CSV_ATTEMPTS,
      maxBytes: MAX_CSV_BYTES,
      // BOM を残すため、Lambda からは base64 にして返す（adminLambdaOptions）。base64 にした大きさで測る
      measure: (x) => Math.ceil(Buffer.byteLength(x) / 3) * 4,
    });
    return c.body(csv, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="results-${examId.replace(/[^\w-]/g, "_")}.csv"`,
    });
  });

  return app;
}

/**
 * 画面から出力できる CSV の上限。Lambda の応答（HTTP API）は 6 MB までのため、base64 にした CSV で
 * 5 MB（CSV で約 3.7 MB）までにする。受験数の上限は、Lambda の時間の上限（25 秒）に収めるため。超える場合は CLI で出力する
 */
const MAX_CSV_BYTES = 5 * 1024 * 1024;
const MAX_CSV_ATTEMPTS = 1000;

function limitOf(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d{1,3}$/.test(raw)) throw invalidRequest();
  return Number(raw);
}

function toAdminUser(u: UserProfile): AdminUser {
  return {
    sub: u.sub,
    email: u.email,
    name: u.name,
    roles: u.roles,
    disabled: u.disabled,
    createdAt: u.createdAt,
  };
}

function toAdminAttempt(a: AttemptRecord): AdminAttempt {
  return {
    attemptId: a.attemptId,
    candidateSub: a.candidateSub,
    candidateName: a.candidateName,
    examId: a.examId,
    examVersion: a.examVersion,
    examTitle: a.examTitle,
    status: a.status,
    issuedAt: a.issuedAt,
    deadlineAt: a.deadlineAt,
    ...(a.startedAt ? { startedAt: a.startedAt } : {}),
    ...(a.submittedAt ? { submittedAt: a.submittedAt } : {}),
    ...(a.canceledAt ? { canceledAt: a.canceledAt } : {}),
    ...(a.assignmentCount !== undefined ? { assignmentCount: a.assignmentCount } : {}),
  };
}
