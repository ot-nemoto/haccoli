import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { AttemptStatus } from "@haccoli/shared";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAdminDownloadUrl,
  getAdminAttemptView,
  listAttemptPage,
  summarizeAttempts,
} from "./admin-attempts.js";
import { NotFoundError, ValidationError } from "./errors.js";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "ap-northeast-1" }));
const ddbMock = mockClient(ddb);
const NOW = "2026-11-20T03:00:00.000Z";
let now = new Date(NOW);
const deps = { ddb, tableName: "t", now: () => now };

const day = (n: number) => new Date(Date.parse(NOW) + n * 24 * 60 * 60 * 1000).toISOString();

interface Row extends Record<string, unknown> {
  PK: string;
  SK: string;
  GSI2PK: string;
  GSI2SK: string;
  attemptId: string;
  status: AttemptStatus;
  deadlineAt: string;
  examId: string;
}

let rows: Row[];

function attempt(id: string, status: AttemptStatus, deadlineAt: string, extra = {}): Row {
  return {
    PK: `ATTEMPT#${id}`,
    SK: "META",
    GSI2PK: `STATUS#${status}`,
    GSI2SK: deadlineAt,
    type: "Attempt",
    attemptId: id,
    candidateSub: `cand-${id}`,
    candidateName: `候補者 ${id}`,
    examId: "ex",
    examVersion: 1,
    examTitle: "課題",
    status,
    issuedAt: "2026-11-01T00:00:00.000Z",
    deadlineAt,
    ...extra,
  };
}

/**
 * GSI2 の Query を模す。1 回の応答は 2 件までにして、LastEvaluatedKey での続きを毎回使わせる。
 * 対応するのは admin-attempts.ts が使う式だけ
 */
function fakeGsi2(input: Record<string, unknown>) {
  const values = input.ExpressionAttributeValues as Record<string, unknown>;
  const kce = String(input.KeyConditionExpression);
  const forward = input.ScanIndexForward !== false;
  const order = (a: Row, b: Row) =>
    (forward ? 1 : -1) * (a.GSI2SK.localeCompare(b.GSI2SK) || a.PK.localeCompare(b.PK));
  let matched = rows
    .filter((r) => r.GSI2PK === values[":pk"])
    .filter((r) =>
      kce.includes("GSI2SK > :at")
        ? r.GSI2SK > String(values[":at"])
        : kce.includes("GSI2SK <= :at")
          ? r.GSI2SK <= String(values[":at"])
          : true,
    )
    .sort(order);
  const start = input.ExclusiveStartKey as Row | undefined;
  if (start) {
    // キー条件の外側のキーから読ませない（DynamoDB は ValidationException にする）
    if (start.GSI2PK !== values[":pk"]) throw new Error("ExclusiveStartKey outside key condition");
    matched = matched.filter((r) => order(r, start) > 0);
  }
  const chunk = matched.slice(0, 2);
  const filter = String(input.FilterExpression ?? "");
  // DynamoDB は Query のフィルタに索引のキーを使えない（ValidationException）
  if (/GSI2(PK|SK)/.test(filter))
    throw new Error("Filter Expression can only contain non-primary key attributes");
  const items = chunk
    .filter((r) => !filter.includes("examId = :examId") || r.examId === values[":examId"])
    .filter(
      (r) => !filter.includes("deadlineAt <= :until") || r.deadlineAt <= String(values[":until"]),
    )
    .filter(
      (r) =>
        !filter.includes("assignmentCount") ||
        r.assignmentCount === undefined ||
        r.assignmentCount === 0,
    );
  const last = chunk[chunk.length - 1];
  const more = matched.length > chunk.length && last;
  const res = {
    ...(input.Select === "COUNT" ? { Count: items.length } : { Items: items }),
    ...(more
      ? {
          LastEvaluatedKey: { PK: last.PK, SK: last.SK, GSI2PK: last.GSI2PK, GSI2SK: last.GSI2SK },
        }
      : {}),
  };
  return res;
}

beforeEach(() => {
  ddbMock.reset();
  now = new Date(NOW);
  rows = [
    attempt("ip-1", "IN_PROGRESS", day(1)),
    attempt("ip-2", "IN_PROGRESS", day(5)),
    // バッチ前の期限切れ（回答中のまま期限を過ぎた）
    attempt("ip-late", "IN_PROGRESS", day(-1)),
    attempt("ns-1", "NOT_STARTED", day(2)),
    attempt("ns-2", "NOT_STARTED", day(10), { examId: "other" }),
    attempt("ns-late", "NOT_STARTED", day(-2)),
    attempt("sub-1", "SUBMITTED", day(-3), { submittedAt: day(-4) }),
    attempt("sub-2", "SUBMITTED", day(-5), { submittedAt: day(-6), assignmentCount: 1 }),
    attempt("sub-3", "SUBMITTED", day(-1), { submittedAt: day(-7) }),
    attempt("gr-1", "GRADING", day(-8), { assignmentCount: 2 }),
    attempt("gd-1", "GRADED", day(-9), { assignmentCount: 1 }),
    attempt("ex-1", "EXPIRED", day(-10)),
    attempt("ca-1", "CANCELED", day(3)),
  ];
  ddbMock.on(QueryCommand).callsFake(fakeGsi2);
  // 割り当てのアイテム（割り当て数を持たない既存データの確認に使う）
  ddbMock
    .on(QueryCommand, { KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)" })
    .callsFake((i) => ({
      Count: assignments.has(String(i.ExpressionAttributeValues[":pk"])) ? 1 : 0,
    }));
  assignments = new Set();
});

/** 割り当てのアイテムがある受験（PK） */
let assignments: Set<string>;

async function readAll(opts: Parameters<typeof listAttemptPage>[1]) {
  const ids: string[][] = [];
  let cursor: string | undefined;
  do {
    const page = await listAttemptPage(deps, { ...opts, cursor });
    ids.push(page.items.map((a) => a.attemptId));
    cursor = page.cursor;
  } while (cursor);
  return ids;
}

describe("listAttemptPage", () => {
  it("すべての受験を、進行中 → 提出済み以降 → 期限切れ → 取消の順に、ページをまたいで重複・欠落なく返す", async () => {
    const pages = await readAll({ limit: 3 });
    expect(pages.flat()).toEqual([
      // 回答中・未着手は期限が近い順
      "ip-1",
      "ip-2",
      "ns-1",
      "ns-2",
      // それ以外は期限が新しい順
      "sub-3",
      "sub-1",
      "sub-2",
      "gr-1",
      "gd-1",
      // 期限切れ：バッチ前（回答中・未着手）→ バッチ後
      "ip-late",
      "ns-late",
      "ex-1",
      "ca-1",
    ]);
    // 最後のページの次は空にしない
    expect(pages.every((p) => p.length > 0)).toBe(true);
    expect(pages.slice(0, -1).every((p) => p.length === 3)).toBe(true);
  });

  it("期限を過ぎた未着手・回答中は「期限切れ」に入り、「未着手」「回答中」に入らない", async () => {
    expect((await readAll({ status: "IN_PROGRESS" })).flat()).toEqual(["ip-1", "ip-2"]);
    expect((await readAll({ status: "NOT_STARTED" })).flat()).toEqual(["ns-1", "ns-2"]);
    const expired = await listAttemptPage(deps, { status: "EXPIRED" });
    expect(expired.items.map((a) => [a.attemptId, a.status])).toEqual([
      ["ip-late", "EXPIRED"],
      ["ns-late", "EXPIRED"],
      ["ex-1", "EXPIRED"],
    ]);
  });

  it("ページの途中で期限を迎えても、1 ページ目の時刻で区切り続ける（重複・欠落しない）", async () => {
    const first = await listAttemptPage(deps, { limit: 1 });
    expect(first.items.map((a) => a.attemptId)).toEqual(["ip-1"]);
    // ip-1 の期限を過ぎた後に続きを読む
    now = new Date(day(1.5));
    const rest: string[] = [];
    let cursor = first.cursor;
    while (cursor) {
      const page = await listAttemptPage(deps, { limit: 4, cursor });
      rest.push(...page.items.map((a) => a.attemptId));
      cursor = page.cursor;
    }
    expect(rest).not.toContain("ip-1");
    expect(rest).toHaveLength(12);
  });

  it("課題で絞り込む（フィルタで空になった応答は読み飛ばす）", async () => {
    const page = await listAttemptPage(deps, { examId: "other" });
    expect(page).toEqual({ items: [expect.objectContaining({ attemptId: "ns-2" })] });
  });

  it("改ざんされたカーソルは拒否する（別の状態・期限の区切りの外側・別の種類のアイテム）", async () => {
    const first = await listAttemptPage(deps, { status: "IN_PROGRESS", limit: 1 });
    const decoded = JSON.parse(Buffer.from(String(first.cursor), "base64url").toString());
    const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const bad = (v: unknown) => listAttemptPage(deps, { status: "IN_PROGRESS", cursor: encode(v) });
    await expect(bad({ ...decoded, k: { ...decoded.k, GSI2PK: "STATUS#GRADED" } })).rejects.toThrow(
      ValidationError,
    );
    // 期限の区切り（1 ページ目の時刻より後）の外側
    await expect(bad({ ...decoded, k: { ...decoded.k, GSI2SK: day(-1) } })).rejects.toThrow(
      ValidationError,
    );
    await expect(
      bad({ ...decoded, k: { ...decoded.k, PK: "USER#x", SK: "PROFILE" } }),
    ).rejects.toThrow(ValidationError);
    await expect(bad({ ...decoded, i: 1 })).rejects.toThrow(ValidationError);
    await expect(bad({ ...decoded, t: "yesterday" })).rejects.toThrow(ValidationError);
    await expect(bad({ ...decoded, extra: 1 })).rejects.toThrow(ValidationError);
    await expect(listAttemptPage(deps, { cursor: "not-json" })).rejects.toThrow(ValidationError);
  });
});

describe("summarizeAttempts", () => {
  it("表示上の状態ごとの件数・期限が近い受験・採点者が未割り当ての提出を返す", async () => {
    const s = await summarizeAttempts(deps);
    expect(s.counts).toEqual({
      NOT_STARTED: 2,
      IN_PROGRESS: 2,
      SUBMITTED: 3,
      EXPIRED: 3,
      GRADING: 1,
      GRADED: 1,
      CANCELED: 1,
    });
    // 3 日以内（期限を過ぎたものは入れない）
    expect(s.dueSoon.map((a) => a.attemptId)).toEqual(["ip-1", "ns-1"]);
    expect(s.dueSoonTotal).toBe(2);
    // 割り当て数がない（または 0）の提出済み。提出が古い順
    expect(s.unassigned.map((a) => a.attemptId)).toEqual(["sub-3", "sub-1"]);
    expect(s.unassignedTotal).toBe(2);
  });

  it("割り当て数を持たない既存データでも、割り当て済みなら未割り当てに入れない", async () => {
    assignments.add("ATTEMPT#sub-1");
    const s = await summarizeAttempts(deps);
    expect(s.unassigned.map((a) => a.attemptId)).toEqual(["sub-3"]);
    expect(s.unassignedTotal).toBe(1);
    // 割り当て数を持つ受験は、割り当てのアイテムを読みに行かない
    const checked = ddbMock
      .commandCalls(QueryCommand)
      .map((c) => c.args[0].input)
      .filter((i) => i.KeyConditionExpression === "PK = :pk AND begins_with(SK, :sk)")
      .map((i) => i.ExpressionAttributeValues?.[":pk"]);
    expect(checked.sort()).toEqual(["ATTEMPT#sub-1", "ATTEMPT#sub-3"]);
  });
});

describe("getAdminAttemptView・createAdminDownloadUrl", () => {
  const files = {
    createUploadUrl: vi.fn(),
    getObjectInfo: vi.fn(),
    deleteObject: vi.fn(),
    createDownloadUrl: vi.fn(async (key: string, name: string) => `https://s3/${key}?n=${name}`),
  };
  const withFiles = { ...deps, files } as unknown as Parameters<typeof createAdminDownloadUrl>[0];

  beforeEach(() => {
    const meta = attempt("a1", "IN_PROGRESS", day(-1));
    ddbMock.on(QueryCommand, { KeyConditionExpression: "PK = :pk" }).callsFake((i) =>
      i.ExpressionAttributeValues[":pk"] === "ATTEMPT#a1"
        ? {
            Items: [
              meta,
              {
                PK: "ATTEMPT#a1",
                SK: "ANS#q1",
                qid: "q1",
                content: { fileKey: "attempts/a1/q1/x.zip", fileName: "提出.zip" },
                version: 1,
                updatedAt: NOW,
              },
              {
                PK: "ATTEMPT#a1",
                SK: "ANS#q2",
                qid: "q2",
                content: { text: "回答" },
                version: 1,
                updatedAt: NOW,
              },
            ],
          }
        : { Items: [] },
    );
    ddbMock.on(GetCommand).callsFake((i) => {
      if (i.Key.PK === "USER#cand-a1") {
        return { Item: { PK: i.Key.PK, SK: "PROFILE", sub: "cand-a1", email: "c@example.com" } };
      }
      if (i.Key.PK === "EXAM#ex") {
        return {
          Item: {
            definition: {
              examId: "ex",
              title: "課題",
              intro: "",
              questions: [{ qid: "q1", type: "file", body: "b" }],
            },
          },
        };
      }
      return {};
    });
  });

  it("詳細は表示上の状態と候補者の登録情報を返す", async () => {
    const v = await getAdminAttemptView(deps, "a1");
    expect(v.attempt.status).toBe("EXPIRED");
    expect(v.candidate?.email).toBe("c@example.com");
    expect(v.answers.map((a) => a.qid)).toEqual(["q1", "q2"]);
    await expect(getAdminAttemptView(deps, "nope")).rejects.toThrow(NotFoundError);
  });

  it("提出ファイルのダウンロード用 URL は、ファイルの回答だけに発行する", async () => {
    expect(await createAdminDownloadUrl(withFiles, { attemptId: "a1", qid: "q1" })).toBe(
      "https://s3/attempts/a1/q1/x.zip?n=提出.zip",
    );
    await expect(createAdminDownloadUrl(withFiles, { attemptId: "a1", qid: "q2" })).rejects.toThrow(
      NotFoundError,
    );
    await expect(
      createAdminDownloadUrl(withFiles, { attemptId: "nope", qid: "q1" }),
    ).rejects.toThrow(NotFoundError);
  });
});
