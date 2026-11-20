import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { loadExamDir, parseExamDefinition, publishExam } from "./exams.js";

function makeExamDir(examJson: object, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "exam-"));
  writeFileSync(join(dir, "exam.json"), JSON.stringify(examJson));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

const validJson = {
  examId: "sample-2026",
  title: "サンプル",
  intro: "intro.md",
  questions: [
    { qid: "q1", type: "text", body: "q1.md", rubric: { body: "r1.md", points: 10 } },
    {
      qid: "q2",
      type: "choice",
      body: "q2.md",
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      rubric: { correct: ["a"] },
    },
  ],
};
const validFiles = { "intro.md": "# 説明", "q1.md": "問1", "r1.md": "基準", "q2.md": "問2" };

describe("loadExamDir", () => {
  it("本文ファイルを展開し、既定値を補う", async () => {
    const def = await loadExamDir(makeExamDir(validJson, validFiles));
    expect(def.intro).toBe("# 説明");
    expect(def.questions[0]).toMatchObject({
      body: "問1",
      maxLength: 20000,
      rubric: { body: "基準", points: 10 },
    });
    expect(def.questions[1]).toMatchObject({ multiple: false });
  });

  it("課題ディレクトリ外のファイル参照は拒否する", async () => {
    const dir = makeExamDir({ ...validJson, intro: "../outside.md" }, validFiles);
    await expect(loadExamDir(dir)).rejects.toThrow("課題ディレクトリ内");
  });

  it("存在しないファイル参照はエラー", async () => {
    const dir = makeExamDir({ ...validJson, intro: "nope.md" }, validFiles);
    await expect(loadExamDir(dir)).rejects.toThrow("読み込めません");
  });
});

describe("parseExamDefinition", () => {
  const base = { examId: "e", title: "t", intro: "", questions: [] as object[] };
  const choice = (extra: object) => ({
    qid: "q1",
    type: "choice",
    body: "b",
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
    ...extra,
  });

  it.each([
    ["問題なし", { ...base }],
    ["qid 重複", { ...base, questions: [choice({}), choice({})] }],
    ["未知の項目", { ...base, questions: [choice({ foo: 1 })] }],
    ["正解に存在しない選択肢", { ...base, questions: [choice({ rubric: { correct: ["z"] } })] }],
    [
      "zip 以外の拡張子",
      {
        ...base,
        questions: [{ qid: "q", type: "file", body: "b", file: { extensions: [".tar"] } }],
      },
    ],
    ["examId の形式", { ...base, examId: "Bad_ID", questions: [choice({})] }],
  ])("%s はエラー", (_, input) => {
    expect(() => parseExamDefinition(input)).toThrow("課題定義が不正です");
  });
});

describe("publishExam", () => {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "ap-northeast-1" }));
  const ddbMock = mockClient(ddb);
  const deps = { ddb, tableName: "t", now: () => new Date("2026-11-20T00:00:00Z") };
  const def = parseExamDefinition({
    examId: "e1",
    title: "t",
    intro: "",
    questions: [{ qid: "q1", type: "text", body: "b" }],
  });

  beforeEach(() => ddbMock.reset());

  it("初回は v1 を作成する", async () => {
    ddbMock.on(GetCommand).resolves({});
    await expect(publishExam(deps, def)).resolves.toEqual({
      kind: "published",
      examId: "e1",
      version: 1,
    });
    const items = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems;
    expect(items?.[0]?.Put?.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(items?.[1]?.Put?.Item).toMatchObject({ PK: "EXAM#e1", SK: "V#000001", version: 1 });
  });

  it("内容が変わっていれば次の版を作成する（META の版を条件にする）", async () => {
    ddbMock
      .on(GetCommand, { Key: { PK: "EXAM#e1", SK: "META" } })
      .resolves({ Item: { latestVersion: 3 } })
      .on(GetCommand, { Key: { PK: "EXAM#e1", SK: "V#000003" } })
      .resolves({ Item: { definition: { ...def, title: "旧" } } });
    await expect(publishExam(deps, def)).resolves.toMatchObject({ version: 4 });
    const meta = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems?.[0];
    expect(meta?.Put?.ExpressionAttributeValues).toEqual({ ":prev": 3 });
  });

  it("最新版と同一内容なら投入しない", async () => {
    ddbMock
      .on(GetCommand, { Key: { PK: "EXAM#e1", SK: "META" } })
      .resolves({ Item: { latestVersion: 5 } })
      .on(GetCommand, { Key: { PK: "EXAM#e1", SK: "V#000005" } })
      .resolves({ Item: { definition: def } });
    await expect(publishExam({ ...deps }, def)).resolves.toEqual({
      kind: "unchanged",
      examId: "e1",
      version: 5,
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});
