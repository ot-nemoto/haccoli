import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import {
  AdminSetUserPasswordCommand,
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
  registerUser,
  s3FileVersionStore,
  saveGrade,
  type UserProfile,
} from "@haccoli/core";
import type { MeResponse } from "@haccoli/shared";

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
    name: "E2E 候補者",
    role: "candidate",
  });
  const grader =
    (await findUserByEmail(ctx.deps, GRADER_EMAIL)) ??
    (await registerUser(ctx.deps, { email: GRADER_EMAIL, name: "E2E 採点者", role: "grader" }));
  if (grader.role !== "grader" || grader.disabled) {
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
    webUrl: ctx.outputs.WebUrl,
    attemptId: attempt.attemptId,
    candidate: { user: candidate, session: await sessionFor(ctx, candidate) },
    grader: { user: grader, session: await sessionFor(ctx, grader) },
  };
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
  // 採点者は残すので、テストで使ったパスワードを使えなくする
  if (grader) {
    try {
      await setPassword(ctx, grader.email, unusablePassword());
    } catch (e) {
      errors.push(e);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `E2E の後片付けに失敗しました（候補者: ${candidateEmail}）`);
  }
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
}

/** E2E は dev のみ。prod に向けて実行されないよう、環境名を固定する */
async function devContext(): Promise<Context> {
  const ctx = await createContext("dev");
  if (ctx.env !== "dev") throw new Error("E2E テストは dev 環境でのみ実行できます");
  return ctx;
}

async function sessionFor(ctx: Context, user: UserProfile): Promise<string> {
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
  const me: MeResponse = { sub: user.sub, name: user.name, role: user.role };
  return JSON.stringify({
    tokens: {
      idToken: r.IdToken,
      accessToken: r.AccessToken,
      refreshToken: r.RefreshToken,
      expiresIn: r.ExpiresIn,
    },
    user: me,
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
