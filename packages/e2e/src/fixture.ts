import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import {
  AdminSetUserPasswordCommand,
  AdminUserGlobalSignOutCommand,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { type Context, createContext } from "@haccoli/admin-cli/context";
import {
  assignGraders,
  cancelAttempt,
  effectiveStatus,
  executePurge,
  finalizeGrade,
  findUserByEmail,
  getAttemptBundle,
  issueAttempt,
  jstDate,
  listAttemptsByCandidate,
  loadExamDir,
  planPurge,
  publishExam,
  type Role,
  registerUser,
  removeRole,
  s3FileVersionStore,
  saveGrade,
  type UserProfile,
} from "@haccoli/core";
import type { MeResponse } from "@haccoli/shared";
import type { Browser, Page } from "@playwright/test";

/**
 * dev 環境に対する E2E テストの準備と後片付け。
 *
 * ログインはメール OTP のため自動化できない。テスト用ユーザーに限り、実行ごとに生成した
 * パスワードを設定して Cognito のトークンを取り、画面の sessionStorage に入れる。
 * パスワードはどこにも保存せず、終了時にもう一度ランダムな値に戻す。
 */

export const EXAM_ID = "sample-2026";
/** 採点者は削除できない（user:purge は候補者のみ）ため、実行をまたいで使い回す */
export const GRADER_EMAIL = "e2e-grader@example.com";
/** 管理画面のテスト用の管理者。dev に常設する（作成は CLI の admin:add。Issue #28） */
export const ADMIN_EMAIL = "e2e-admin@example.com";
/** 画面の保存先（packages/web/src/auth/session.ts と合わせる） */
export const SESSION_KEY = "haccoli.session";

export interface Actor {
  user: UserProfile;
  /** sessionStorage に入れる値（packages/web/src/auth/session.ts の Session） */
  session: string;
}

export interface Fixture {
  ctx: Context;
  webUrl: string;
  attemptId: string;
  candidate: Actor;
  grader: Actor;
}

/** 対象環境（dev）に接続し、この実行で使う候補者のメールアドレスを決める */
export async function setUp(): Promise<{ ctx: Context; candidateEmail: string }> {
  const ctx = await devContext();
  const candidateEmail = `e2e-cand-${Date.now()}-${randomBytes(3).toString("hex")}@example.com`;
  return { ctx, candidateEmail };
}

/** テスト用の候補者・採点者・受験を用意し、それぞれのセッションを作る */
export async function prepare(ctx: Context, candidateEmail: string): Promise<Fixture> {
  const examDir = fileURLToPath(new URL(`../../../exams/${EXAM_ID}`, import.meta.url));
  await publishExam(ctx.deps, await loadExamDir(examDir));

  const candidate = await registerUser(ctx.deps, {
    email: candidateEmail,
    // 採点者は使い回すため、担当一覧で前回の実行と区別できる名前にする
    name: `E2E 候補者 ${candidateEmail.split("@")[0]?.replace("e2e-cand-", "")}`,
    roles: ["candidate"],
  });
  const grader =
    (await findUserByEmail(ctx.deps, GRADER_EMAIL)) ??
    (await registerUser(ctx.deps, { email: GRADER_EMAIL, name: "E2E 採点者", roles: ["grader"] }));
  if (!grader.roles.includes("grader") || grader.disabled) {
    throw new Error(`${GRADER_EMAIL} が有効な採点者ではありません`);
  }

  const tomorrow = jstDate(new Date(Date.now() + 24 * 60 * 60 * 1000));
  const attempt = await issueAttempt(ctx.deps, {
    email: candidate.email,
    examId: EXAM_ID,
    deadline: tomorrow,
  });

  return {
    ctx,
    // ローカルの画面（npm run web:dev）で試す場合は HACCOLI_E2E_BASE_URL で指定する
    webUrl: process.env.HACCOLI_E2E_BASE_URL || ctx.outputs.WebUrl,
    attemptId: attempt.attemptId,
    candidate: { user: candidate, session: await sessionFor(ctx, candidate) },
    grader: { user: grader, session: await sessionFor(ctx, grader) },
  };
}

/**
 * 管理画面から受験を発行するテスト用。課題を投入し、候補者を登録する（受験は発行しない）。
 * 後片付けは tearDown（user:purge と同じ処理）で行う
 */
export async function prepareCandidate(ctx: Context, candidateEmail: string): Promise<UserProfile> {
  const examDir = fileURLToPath(new URL(`../../../exams/${EXAM_ID}`, import.meta.url));
  await publishExam(ctx.deps, await loadExamDir(examDir));
  return registerUser(ctx.deps, {
    email: candidateEmail,
    name: `E2E 候補者 ${candidateEmail.split("@")[0]?.replace("e2e-cand-", "")}`,
    roles: ["candidate"],
  });
}

export async function assignGrader(f: Fixture): Promise<void> {
  await assignGraders(f.ctx.deps, { attemptId: f.attemptId, graderEmails: [GRADER_EMAIL] });
}

export async function attemptStatus(f: Fixture): Promise<string | undefined> {
  return (await getAttemptBundle(f.ctx.deps, f.attemptId))?.attempt.status;
}

/**
 * 後片付け。テストが途中で失敗しても候補者のデータを残さないよう、
 * 受験を削除できる状態（取消・採点済み）まで進めてから、user:purge と同じ処理で削除する。
 */
export async function tearDown(ctx: Context, candidateEmail: string): Promise<void> {
  const errors: unknown[] = [];
  const grader = await findUserByEmail(ctx.deps, GRADER_EMAIL);
  const candidate = await findUserByEmail(ctx.deps, candidateEmail);
  if (candidate) {
    try {
      await settleAttempts(ctx, candidate.sub);
      const deps = {
        ...ctx.deps,
        fileVersions: s3FileVersionStore(ctx.s3, ctx.outputs.SubmissionsBucket),
      };
      await executePurge(deps, await planPurge(deps, candidate.email));
    } catch (e) {
      errors.push(e);
    }
  }
  // 採点者は残すので、テストで使ったパスワードを使えなくし、リフレッシュトークンも失効させる
  if (grader) {
    try {
      await lockOut(ctx, grader.email);
    } catch (e) {
      errors.push(e);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `E2E の後片付けに失敗しました（候補者: ${candidateEmail}）`);
  }
}

export interface StaffFixture {
  ctx: Context;
  webUrl: string;
  admin: Actor;
  grader: Actor;
}

/** 管理画面のテスト用。常設の管理者・採点者のセッションを作る */
export async function prepareStaff(ctx: Context): Promise<StaffFixture> {
  const admin = await findUserByEmail(ctx.deps, ADMIN_EMAIL);
  if (!admin?.roles.includes("admin") || admin.disabled) {
    throw new Error(
      `${ADMIN_EMAIL} が有効な管理者ではありません。npm run admin -- -e dev admin:add で登録してください`,
    );
  }
  let grader =
    (await findUserByEmail(ctx.deps, GRADER_EMAIL)) ??
    (await registerUser(ctx.deps, { email: GRADER_EMAIL, name: "E2E 採点者", roles: ["grader"] }));
  if (!grader.roles.includes("grader") || grader.disabled) {
    throw new Error(`${GRADER_EMAIL} が有効な採点者ではありません`);
  }
  // 前回の後片付けが途中で失敗して admin が残っていたら、外してから始める（テストで付与するため）
  if (grader.roles.includes("admin")) {
    grader = await removeRole(ctx.deps, { email: GRADER_EMAIL, role: "admin" });
  }
  return {
    ctx,
    webUrl: process.env.HACCOLI_E2E_BASE_URL || ctx.outputs.WebUrl,
    admin: { user: admin, session: await sessionFor(ctx, admin, "admin") },
    grader: { user: grader, session: await sessionFor(ctx, grader, "grader") },
  };
}

/**
 * 管理画面のテストの後片付け。採点者のロールを grader だけに戻し（テストで admin を付与するため）、
 * 管理者・採点者のパスワードを使えなくする
 */
export async function tearDownStaff(ctx: Context): Promise<void> {
  const errors: unknown[] = [];
  const grader = await findUserByEmail(ctx.deps, GRADER_EMAIL);
  if (grader?.roles.includes("admin")) {
    await removeRole(ctx.deps, { email: GRADER_EMAIL, role: "admin" }).catch((e) => errors.push(e));
  }
  for (const email of [ADMIN_EMAIL, GRADER_EMAIL]) {
    await lockOut(ctx, email).catch((e) => errors.push(e));
  }
  if (errors.length > 0) throw new AggregateError(errors, "E2E の後片付けに失敗しました");
}

/** トークンを sessionStorage に入れた状態で画面を開く（OTP のログインを経ない） */
export async function openPage(
  browser: Browser,
  webUrl: string,
  session: string,
  path: string,
): Promise<{ page: Page; [Symbol.asyncDispose]: () => Promise<void> }> {
  const context = await browser.newContext({ baseURL: webUrl });
  await context.addInitScript(
    ([key, value]) => {
      if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, value);
    },
    [SESSION_KEY, session] as const,
  );
  const page = await context.newPage();
  await page.goto(path);
  // テストの終わりにコンテキストを閉じる（await using）
  return { page, [Symbol.asyncDispose]: () => context.close() };
}

/**
 * テストで使ったパスワードを使えなくし、リフレッシュトークンも失効させる
 * （アクセストークンは有効期限の 60 分まで使える。API Gateway の JWT 検証は失効を見ないため）
 */
async function lockOut(ctx: Context, email: string): Promise<void> {
  await setPassword(ctx, email, unusablePassword());
  await ctx.deps.cognito.send(
    new AdminUserGlobalSignOutCommand({ UserPoolId: ctx.deps.userPoolId, Username: email }),
  );
}

async function settleAttempts(ctx: Context, candidateSub: string): Promise<void> {
  const grader = await findUserByEmail(ctx.deps, GRADER_EMAIL);
  for (const attempt of await listAttemptsByCandidate(ctx.deps, candidateSub)) {
    const status = effectiveStatus(attempt, new Date());
    if (status === "NOT_STARTED" || status === "IN_PROGRESS") {
      await cancelAttempt(ctx.deps, { attemptId: attempt.attemptId });
      continue;
    }
    if (status === "SUBMITTED") {
      await assignGraders(ctx.deps, {
        attemptId: attempt.attemptId,
        graderEmails: [GRADER_EMAIL],
      });
    }
    if (status === "SUBMITTED" || status === "GRADING") {
      const bundle = await getAttemptBundle(ctx.deps, attempt.attemptId);
      for (const a of bundle?.assignments ?? []) {
        if (a.status === "DONE") continue;
        if (a.graderSub !== grader?.sub) {
          throw new Error(`E2E 以外の採点者が割り当てられています: ${attempt.attemptId}`);
        }
        const grade = bundle?.grades.find((g) => g.graderSub === a.graderSub);
        const saved = await saveGrade(ctx.deps, {
          attemptId: attempt.attemptId,
          graderSub: a.graderSub,
          items: {},
          overallComment: "E2E の後片付け",
          version: grade?.version ?? 0,
        });
        await finalizeGrade(ctx.deps, {
          attemptId: attempt.attemptId,
          graderSub: a.graderSub,
          version: saved.version,
        });
      }
    }
  }
  // 削除できない状態のまま残っていれば、原因の受験がわかるように止める
  for (const attempt of await listAttemptsByCandidate(ctx.deps, candidateSub)) {
    const status = effectiveStatus(attempt, new Date());
    if (!["GRADED", "CANCELED", "EXPIRED"].includes(status)) {
      throw new Error(`受験 ${attempt.attemptId} を削除できる状態にできませんでした（${status}）`);
    }
  }
}

/** E2E は dev のみ。prod に向けて実行されないよう、環境名を固定する */
export async function devContext(): Promise<Context> {
  const ctx = await createContext("dev");
  if (ctx.env !== "dev") throw new Error("E2E テストは dev 環境でのみ実行できます");
  return ctx;
}

async function sessionFor(
  ctx: Context,
  user: UserProfile,
  // ログインした画面のロール（packages/web/src/auth/session.ts）
  role: Role = user.roles.includes("candidate") ? "candidate" : "grader",
): Promise<string> {
  const password = unusablePassword();
  await setPassword(ctx, user.email, password);
  const res = await ctx.deps.cognito.send(
    new InitiateAuthCommand({
      ClientId: ctx.outputs.UserPoolClientId,
      AuthFlow: "USER_AUTH",
      AuthParameters: { USERNAME: user.email, PASSWORD: password, PREFERRED_CHALLENGE: "PASSWORD" },
    }),
  );
  const r = res.AuthenticationResult;
  if (!r?.IdToken || !r.AccessToken || !r.ExpiresIn) {
    throw new Error(`トークンを取得できませんでした（${res.ChallengeName ?? "不明"}）`);
  }
  const me: MeResponse = { sub: user.sub, name: user.name, roles: user.roles };
  return JSON.stringify({
    tokens: {
      idToken: r.IdToken,
      accessToken: r.AccessToken,
      refreshToken: r.RefreshToken,
      expiresIn: r.ExpiresIn,
    },
    user: me,
    role,
    expiresAt: Date.now() + r.ExpiresIn * 1000,
  });
}

async function setPassword(ctx: Context, email: string, password: string): Promise<void> {
  await ctx.deps.cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: ctx.deps.userPoolId,
      Username: email,
      Password: password,
      Permanent: true,
    }),
  );
}

function unusablePassword(): string {
  return `${randomBytes(48).toString("base64url")}Aa1!`;
}

/** 提出用の小さな zip（無圧縮・1 ファイル）。サーバーは先頭のマジックナンバーで検証する */
export function tinyZip(name: string, content: string): Buffer {
  const data = Buffer.from(content);
  const file = Buffer.from(name);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(file.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(file.length, 28);
  const centralOffset = local.length + file.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + file.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, file, data, central, file, end]);
}
