import * as z from "zod";
import { ROLES } from "./roles.js";

/**
 * zod スキーマ（サーバー側の検証用）。画面のバンドルに zod を含めないよう、
 * パッケージの入口（index）からは再エクスポートせず @haccoli/shared/schemas で読み込む。
 *
 * 課題定義（docs/design.md §5）。exams/<examId>/exam.json の本文ファイル参照を
 * 読み込んで展開した後の形。1 版 = DynamoDB の 1 アイテムとして保存する。
 */

const id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "英小文字・数字・ハイフン（先頭は英数字、63 文字以内）");

/** 採点情報。候補者向け API では必ず除外する（§5.1） */
export const rubricSchema = z
  .object({
    /** 採点基準（Markdown） */
    body: z.string().optional(),
    /** 配点 */
    points: z.number().nonnegative().optional(),
    /** 選択式の正解（option id） */
    correct: z.array(z.string()).optional(),
  })
  .strict();

const base = {
  qid: id,
  /** 問題文（Markdown） */
  body: z.string().min(1),
  rubric: rubricSchema.optional(),
};

export const textQuestionSchema = z
  .object({
    ...base,
    type: z.literal("text"),
    maxLength: z.number().int().positive().max(100_000).default(20_000),
  })
  .strict();

export const choiceQuestionSchema = z
  .object({
    ...base,
    type: z.literal("choice"),
    multiple: z.boolean().default(false),
    options: z
      .array(z.object({ id, label: z.string().min(1) }).strict())
      .min(2)
      .refine((opts) => new Set(opts.map((o) => o.id)).size === opts.length, "選択肢 id が重複"),
  })
  .strict()
  .refine(
    (q) => (q.rubric?.correct ?? []).every((c) => q.options.some((o) => o.id === c)),
    "rubric.correct に存在しない選択肢 id があります",
  );

export const fileQuestionSchema = z
  .object({
    ...base,
    type: z.literal("file"),
    file: z
      .object({
        maxSizeMB: z.number().positive().max(20).default(20),
        extensions: z.array(z.literal(".zip")).default([".zip"]),
      })
      .strict()
      .default({ maxSizeMB: 20, extensions: [".zip"] }),
  })
  .strict();

export const questionSchema = z.discriminatedUnion("type", [
  textQuestionSchema,
  choiceQuestionSchema,
  fileQuestionSchema,
]);

export const examDefinitionSchema = z
  .object({
    examId: id,
    title: z.string().min(1).max(200),
    /** 冒頭説明（Markdown） */
    intro: z.string(),
    questions: z
      .array(questionSchema)
      .min(1)
      .refine((qs) => new Set(qs.map((q) => q.qid)).size === qs.length, "qid が重複しています"),
  })
  .strict();

/**
 * 課題の下書き（docs/design.md §14.5）。編集の途中の内容を保存できるよう、公開時の検証
 * （examDefinitionSchema）より緩くし、形（項目名・型・長さの上限）だけを確かめる。
 * 未入力の問題文・選択肢の不足・qid の重複などは、公開の前に直すべき点として返す
 */
const draftId = z.string().max(63);
const draftText = z.string().max(100_000);
export const draftQuestionSchema = z
  .object({
    qid: draftId,
    type: z.enum(["text", "choice", "file"]),
    body: draftText,
    rubric: z
      .object({
        body: draftText.optional(),
        points: z.number().nonnegative().optional(),
        correct: z.array(draftId).max(50).optional(),
      })
      .strict()
      .optional(),
    maxLength: z.number().int().positive().max(100_000).optional(),
    multiple: z.boolean().optional(),
    options: z
      .array(z.object({ id: draftId, label: z.string().max(1_000) }).strict())
      .max(50)
      .optional(),
    file: z
      .object({
        maxSizeMB: z.number().positive().max(20).optional(),
        extensions: z.array(z.literal(".zip")).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const examDraftSchema = z
  .object({
    examId: id,
    title: z.string().max(200),
    intro: draftText,
    questions: z.array(draftQuestionSchema).max(100),
  })
  .strict();

export type DraftQuestion = z.infer<typeof draftQuestionSchema>;
export type ExamDraftDefinition = z.infer<typeof examDraftSchema>;

/** PUT /api/admin/exams/{examId}/draft */
export const adminSaveDraftRequestSchema = z
  .object({
    definition: examDraftSchema,
    /** 読み込んだ時点の下書きの版（下書きがなければ 0）。楽観ロックに使う */
    version: z.number().int().nonnegative(),
    /** 元にした版を、今の最新版に付け替える（最新版の内容から作り直したとき）。元にした版はサーバーが決める */
    rebase: z.boolean().default(false),
    /**
     * 下書きを初めて作るとき（version 0）だけ使う、画面が編集を始めた公開版。編集を始めた後に新しい版が
     * 公開されていたら、元にした版を古いままにする（公開を止めて作り直しを促す）。省略すると今の最新版
     */
    startedFrom: z.number().int().nonnegative().optional(),
    /** 新しい課題として作る（既にある課題 ID なら 409） */
    create: z.boolean().default(false),
  })
  .strict();

/** POST /api/admin/exams/{examId}/publish */
export const adminPublishDraftRequestSchema = z
  .object({ version: z.number().int().positive() })
  .strict();

export type Rubric = z.infer<typeof rubricSchema>;
export type TextQuestion = z.infer<typeof textQuestionSchema>;
export type ChoiceQuestion = z.infer<typeof choiceQuestionSchema>;
export type FileQuestion = z.infer<typeof fileQuestionSchema>;
export type Question = z.infer<typeof questionSchema>;
export type ExamDefinition = z.infer<typeof examDefinitionSchema>;

/** 回答内容（§5.1） */
export const textAnswerSchema = z.object({ text: z.string() }).strict();
export const choiceAnswerSchema = z.object({ selected: z.array(z.string()) }).strict();
/** ファイル提出の保存リクエスト。サイズ・ハッシュはサーバーが S3 の実体から求める */
export const fileAnswerRequestSchema = z
  .object({ fileKey: z.string().min(1).max(1024), fileName: z.string().min(1).max(255) })
  .strict();
export type TextAnswer = z.infer<typeof textAnswerSchema>;
export type ChoiceAnswer = z.infer<typeof choiceAnswerSchema>;
/** 保存されたファイル提出（§5.1） */
export interface FileAnswer {
  fileKey: string;
  /** 表示用の元のファイル名 */
  fileName: string;
  size: number;
  /** 提出物の同一性確認用（16 進） */
  sha256: string;
  uploadedAt: string;
}
export type AnswerContent = TextAnswer | ChoiceAnswer | FileAnswer;

/** POST /api/candidate/attempts/{attemptId}/answers/{qid}/upload-url */
export const uploadUrlRequestSchema = z
  .object({ fileName: z.string().min(1).max(255), size: z.number().int().positive() })
  .strict();

/** PUT /api/candidate/attempts/{attemptId}/answers/{qid} */
export const saveAnswerRequestSchema = z
  .object({
    content: z.unknown(),
    /** 読み込んだ時点の版（未保存なら 0）。楽観ロックに使う */
    version: z.number().int().nonnegative(),
  })
  .strict();
export type SaveAnswerRequest = { content: AnswerContent; version: number };

/** 採点（問題ごとの点数・コメント）。集計ルールは別途検討（§6.1 Grade） */
export const gradeItemSchema = z
  .object({
    score: z.number().finite().nonnegative().optional(),
    comment: z.string().max(10_000).optional(),
  })
  .strict();

/** PUT /api/grader/attempts/{attemptId}/grade */
export const saveGradeRequestSchema = z
  .object({
    items: z.record(z.string(), gradeItemSchema),
    overallComment: z.string().max(10_000).default(""),
    /** 読み込んだ時点の版（未保存なら 0）。楽観ロックに使う */
    version: z.number().int().nonnegative(),
  })
  .strict();

/** POST /api/grader/attempts/{attemptId}/grade/finalize */
export const finalizeGradeRequestSchema = z
  .object({ version: z.number().int().positive() })
  .strict();

export type GradeItem = z.infer<typeof gradeItemSchema>;

/** 管理者 API（docs/design.md §14.6） */
export const adminCreateUserRequestSchema = z
  .object({
    email: z.string().trim().min(3).max(254),
    name: z.string().trim().min(1).max(100),
    roles: z.array(z.enum(ROLES)).min(1).max(ROLES.length),
  })
  .strict();

export const adminSetRolesRequestSchema = z
  .object({
    roles: z
      .array(z.enum(["grader", "admin"]))
      .min(1)
      .max(2),
  })
  .strict();

const deadlineDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const adminIssueAttemptRequestSchema = z
  .object({
    email: z.string().trim().min(3).max(254),
    examId: z.string().min(1).max(100),
    deadline: deadlineDate,
  })
  .strict();

export const adminExtendAttemptRequestSchema = z.object({ deadline: deadlineDate }).strict();

export const adminAssignRequestSchema = z
  .object({ graderEmails: z.array(z.string().trim().min(3).max(254)).min(1).max(20) })
  .strict();
