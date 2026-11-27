import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditMonth, describeError, listAuditLogs, withAudit } from "./audit.js";
import { ValidationError } from "./errors.js";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "ap-northeast-1" }));
const ddbMock = mockClient(ddb);
const deps = {
  ddb,
  auditTableName: "audit",
  actor: { type: "admin" as const, sub: "admin-1", name: "管理 一郎" },
  now: () => new Date("2026-11-30T15:30:00Z"),
};

beforeEach(() => ddbMock.reset());

describe("auditMonth", () => {
  it("月は JST で決める", () => {
    expect(auditMonth(new Date("2026-11-30T14:59:59Z"))).toBe("202611");
    expect(auditMonth(new Date("2026-11-30T15:00:00Z"))).toBe("202612");
  });
});

describe("withAudit", () => {
  it("実行前に STARTED を書き、成功したら SUCCEEDED と結果を記録する", async () => {
    const order: string[] = [];
    ddbMock.on(PutCommand).callsFake(() => {
      order.push("audit:started");
      return {};
    });
    ddbMock.on(UpdateCommand).callsFake(() => {
      order.push("audit:finished");
      return {};
    });
    const value = await withAudit(
      deps,
      { action: "user.add", detail: { roles: ["grader"] } },
      async () => {
        order.push("run");
        return { sub: "new-sub" };
      },
      (v) => ({ target: { type: "user", id: v.sub }, detail: { created: true } }),
    );
    expect(value).toEqual({ sub: "new-sub" });
    expect(order).toEqual(["audit:started", "run", "audit:finished"]);

    const started = ddbMock.commandCalls(PutCommand)[0]?.args[0].input;
    expect(started?.TableName).toBe("audit");
    expect(started?.Item).toMatchObject({
      // 2026-12-01 00:30 JST
      PK: "AUDIT#202612",
      type: "Audit",
      action: "user.add",
      status: "STARTED",
      actor: deps.actor,
      at: "2026-11-30T15:30:00.000Z",
    });
    expect(started?.Item?.SK).toMatch(/^2026-11-30T15:30:00\.000Z#[0-9a-f-]{36}$/);
    expect(started?.ConditionExpression).toBe("attribute_not_exists(PK)");

    const finished = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(finished?.Key).toEqual({ PK: "AUDIT#202612", SK: started?.Item?.SK });
    expect(finished?.ConditionExpression).toBe("#s = :started");
    expect(finished?.ExpressionAttributeValues).toMatchObject({
      ":status": "SUCCEEDED",
      ":target": { type: "user", id: "new-sub" },
      ":detail": { roles: ["grader"], created: true },
    });
  });

  it("STARTED を書けなければ操作しない", async () => {
    ddbMock.on(PutCommand).rejects(new Error("throttled"));
    const run = vi.fn(async () => "x");
    await expect(withAudit(deps, { action: "user.disable" }, run)).rejects.toThrow("throttled");
    expect(run).not.toHaveBeenCalled();
  });

  it("操作が失敗したら FAILED と理由を記録し、元のエラーを返す", async () => {
    const err = new Error("登録されていないメールアドレスです: Foo.Bar@example.com");
    await expect(
      withAudit(deps, { action: "user.disable" }, async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(
      ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input.ExpressionAttributeValues,
    ).toMatchObject({
      ":status": "FAILED",
      ":error": "Error: 登録されていないメールアドレスです: <email>",
    });
  });

  it("結果の記録に失敗しても操作の結果は変えない（STARTED のまま残る）", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    ddbMock.on(UpdateCommand).rejects(new Error("network"));
    await expect(withAudit(deps, { action: "user.disable" }, async () => 42)).resolves.toBe(42);
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });
});

describe("describeError", () => {
  it("メールアドレスを伏せ、長さを抑える", () => {
    expect(describeError(new Error("a <x.y+z@example.co.jp> b"))).toBe("Error: a <<email>> b");
    expect(describeError(new Error("x".repeat(1000)))).toHaveLength(500);
  });
});

describe("listAuditLogs", () => {
  it("月のパーティションを新しい順に読み、操作の種類で絞り込む", async () => {
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({
        Items: [{ id: "b", month: "202611", action: "attempt.issue", status: "SUCCEEDED" }],
        LastEvaluatedKey: { PK: "AUDIT#202611", SK: "b" },
      })
      .resolves({
        Items: [{ id: "a", month: "202611", action: "attempt.issue", status: "STARTED" }],
      });
    const logs = await listAuditLogs(deps, { month: "202611", action: "attempt.issue" });
    expect(logs.map((l) => [l.id, l.status])).toEqual([
      ["b", "SUCCEEDED"],
      ["a", "STARTED"],
    ]);
    const input = ddbMock.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(input).toMatchObject({
      TableName: "audit",
      KeyConditionExpression: "PK = :pk",
      FilterExpression: "#a = :action",
      ExpressionAttributeValues: { ":pk": "AUDIT#202611", ":action": "attempt.issue" },
      ScanIndexForward: false,
    });
  });

  it("月の形式が違えばエラー", async () => {
    await expect(listAuditLogs(deps, { month: "2026-11" })).rejects.toBeInstanceOf(ValidationError);
  });
});
