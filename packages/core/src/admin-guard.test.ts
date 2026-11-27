import {
  AdminAddUserToGroupCommand,
  AdminDisableUserCommand,
  AdminRemoveUserFromGroupCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { StateError, ValidationError } from "./errors.js";
import { disableUser, removeRole, setStaffRoles } from "./users.js";

/**
 * 管理者（画面）による admin の削除・無効化の保護（docs/design.md §14.1）。
 * 確認と更新を 1 つのトランザクションにし、同時に実行しても有効な管理者が 0 人にならないこと。
 *
 * DynamoDB は、使う条件式だけを評価する小さな偽物で置き換える。トランザクションは直列に処理する
 * （DynamoDB のトランザクションは直列化される）。
 */

const cognitoMock = mockClient(CognitoIdentityProviderClient);
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "ap-northeast-1" }));
const ddbMock = mockClient(ddb);

/** roles がないのは移行前のアイテム（role のみ） */
type Item = Record<string, unknown> & { sub: string; roles?: string[]; disabled: boolean };
let store: Map<string, Item>;
/** 業務テーブルへの書き込み（トランザクション）の入力 */
let transactions: TransactWriteCommandInput[];
/** 指定した数のトランザクションがそろうまで待たせる（同時実行の再現）。0 なら待たない */
let gate: { expected: number; waiting: (() => void)[] };

const user = (sub: string, roles: string[], extra: Partial<Item> = {}): Item => ({
  PK: `USER#${sub}`,
  SK: "PROFILE",
  type: "User",
  sub,
  email: `${sub}@example.com`,
  name: sub,
  roles,
  disabled: false,
  // 一覧（listUsers）は登録順。sub の順にそろえる
  createdAt: `2026-11-01T00:00:00.000Z#${sub}`,
  ...extra,
});

const subOf = (key: unknown) => String((key as { PK: string }).PK).replace("USER#", "");

const hasAdmin = (i: Item) => !!i.roles?.includes("admin") || i.role === "admin";
const activeAdmin = (i: Item | undefined) => !!i && hasAdmin(i) && !i.disabled;

/** 使う条件式だけを評価する */
function holds(
  item: Item | undefined,
  expr: string | undefined,
  values: Record<string, unknown> = {},
): boolean {
  switch (expr) {
    case undefined:
      return true;
    case "attribute_exists(PK)":
      return !!item;
    case "#rs = :prev":
      return !!item && JSON.stringify(item.roles) === JSON.stringify(values[":prev"]);
    case "(contains(#rs, :admin) OR #r = :admin) AND (attribute_not_exists(#d) OR #d = :false)":
      return activeAdmin(item);
    default:
      throw new Error(`未対応の条件式: ${expr}`);
  }
}

function apply(item: Item, expr: string | undefined, values: Record<string, unknown> = {}): void {
  if (expr === "SET #rs = :next REMOVE #r") item.roles = values[":next"] as string[];
  else if (expr === "SET disabled = :true") item.disabled = true;
  else throw new Error(`未対応の更新式: ${expr}`);
}

function runTransaction(input: TransactWriteCommandInput) {
  const items = input.TransactItems ?? [];
  const codes = items.map((t) => {
    if (t.Update) {
      const ok = holds(
        store.get(subOf(t.Update.Key)),
        t.Update.ConditionExpression,
        t.Update.ExpressionAttributeValues,
      );
      return ok ? "None" : "ConditionalCheckFailed";
    }
    if (t.ConditionCheck) {
      const ok = holds(
        store.get(subOf(t.ConditionCheck.Key)),
        t.ConditionCheck.ConditionExpression,
        t.ConditionCheck.ExpressionAttributeValues,
      );
      return ok ? "None" : "ConditionalCheckFailed";
    }
    throw new Error("未対応の操作");
  });
  if (codes.some((c) => c !== "None")) {
    throw Object.assign(new Error("Transaction cancelled"), {
      name: "TransactionCanceledException",
      CancellationReasons: codes.map((Code) => ({ Code })),
    });
  }
  for (const t of items) {
    if (t.Update) {
      const item = store.get(subOf(t.Update.Key));
      if (item) apply(item, t.Update.UpdateExpression, t.Update.ExpressionAttributeValues);
    }
  }
  return {};
}

beforeEach(() => {
  cognitoMock.reset();
  ddbMock.reset();
  store = new Map();
  transactions = [];
  gate = { expected: 0, waiting: [] };

  cognitoMock.on(AdminRemoveUserFromGroupCommand).resolves({});
  cognitoMock.on(AdminAddUserToGroupCommand).resolves({});
  cognitoMock.on(AdminDisableUserCommand).resolves({});
  ddbMock.on(GetCommand).callsFake((i) => {
    const item = store.get(subOf(i.Key));
    return { Item: item ? structuredClone(item) : undefined };
  });
  ddbMock.on(QueryCommand).callsFake((i) => {
    const email = String(i.ExpressionAttributeValues[":pk"]).replace("EMAIL#", "");
    return { Items: [...store.values()].filter((u) => u.email === email).map((u) => ({ ...u })) };
  });
  ddbMock.on(ScanCommand).callsFake(() => ({
    Items: [...store.values()].filter(hasAdmin).map((u) => ({ ...u })),
  }));
  // 監査ログの記録は数えない
  ddbMock.on(PutCommand, { TableName: "audit" }).resolves({});
  ddbMock.on(UpdateCommand, { TableName: "audit" }).resolves({});
  ddbMock.on(UpdateCommand, { TableName: "t" }).callsFake((i) => {
    const item = store.get(subOf(i.Key));
    if (!holds(item, i.ConditionExpression, i.ExpressionAttributeValues) || !item) {
      throw Object.assign(new Error("x"), { name: "ConditionalCheckFailedException" });
    }
    apply(item, i.UpdateExpression, i.ExpressionAttributeValues);
    return {};
  });
  ddbMock.on(TransactWriteCommand).callsFake(async (input: TransactWriteCommandInput) => {
    transactions.push(input);
    if (gate.expected > 0) {
      // すべての操作が読み込みを終えて書き込みに来るまで待ち、そのあと 1 つずつ処理する
      await new Promise<void>((resolve) => {
        gate.waiting.push(resolve);
        if (gate.waiting.length === gate.expected) {
          gate.expected = 0;
          for (const r of gate.waiting) r();
        }
      });
    }
    return runTransaction(input);
  });
});

const deps = {
  cognito: new CognitoIdentityProviderClient({ region: "ap-northeast-1" }),
  ddb,
  userPoolId: "pool",
  tableName: "t",
  auditTableName: "audit",
};
const asAdmin = (sub: string) => ({
  ...deps,
  actor: { type: "admin" as const, sub, name: sub },
});
const asIam = { ...deps, actor: { type: "iam" as const, arn: "arn:aws:iam::123456789012:user/x" } };

const activeAdmins = () => [...store.values()].filter(activeAdmin).map((u) => u.sub);

const seed = (...users: Item[]) => {
  for (const u of users) store.set(u.sub, u);
};

describe("最後の管理者の保護（トランザクション）", () => {
  it("対象の更新と、ほかの有効な管理者の確認を 1 つのトランザクションにする", async () => {
    seed(user("a", ["admin"]), user("b", ["grader", "admin"]));
    await removeRole(asAdmin("a"), { sub: "b", role: "admin" });

    expect(transactions).toHaveLength(1);
    const [update, check] = transactions[0]?.TransactItems ?? [];
    expect(update?.Update?.Key).toEqual({ PK: "USER#b", SK: "PROFILE" });
    expect(check?.ConditionCheck).toMatchObject({
      TableName: "t",
      Key: { PK: "USER#a", SK: "PROFILE" },
      ConditionExpression:
        "(contains(#rs, :admin) OR #r = :admin) AND (attribute_not_exists(#d) OR #d = :false)",
      ExpressionAttributeNames: { "#rs": "roles", "#r": "role", "#d": "disabled" },
    });
    expect(store.get("b")?.roles).toEqual(["grader"]);
    // DynamoDB を変えてから Cognito のグループを外す
    expect(cognitoMock.commandCalls(AdminRemoveUserFromGroupCommand)).toHaveLength(1);
  });

  it("互いの admin を同時に外すと、片方は失敗し、有効な管理者は 0 人にならない", async () => {
    seed(user("a", ["grader", "admin"]), user("b", ["grader", "admin"]));
    gate.expected = 2;
    const results = await Promise.allSettled([
      removeRole(asAdmin("a"), { sub: "b", role: "admin" }),
      removeRole(asAdmin("b"), { sub: "a", role: "admin" }),
    ]);

    // どちらも、相手がまだ管理者である状態を読んでから書き込みに来ている
    expect(transactions).toHaveLength(2);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(StateError);
    expect(String((rejected as PromiseRejectedResult).reason.message)).toMatch("最後の 1 人");
    expect(activeAdmins()).toHaveLength(1);
    // 失敗した側は Cognito のグループを外さない
    expect(cognitoMock.commandCalls(AdminRemoveUserFromGroupCommand)).toHaveLength(1);
  });

  it("互いに無効化し合っても、有効な管理者は 0 人にならない", async () => {
    seed(user("a", ["admin"]), user("b", ["admin"]));
    gate.expected = 2;
    const results = await Promise.allSettled([
      disableUser(asAdmin("a"), { sub: "b" }),
      disableUser(asAdmin("b"), { sub: "a" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(activeAdmins()).toHaveLength(1);
    expect(cognitoMock.commandCalls(AdminDisableUserCommand)).toHaveLength(1);
  });

  it("admin を外す操作と無効化が同時でも、有効な管理者は 0 人にならない", async () => {
    seed(user("a", ["grader", "admin"]), user("b", ["admin"]));
    gate.expected = 2;
    const results = await Promise.allSettled([
      removeRole(asAdmin("b"), { sub: "a", role: "admin" }),
      disableUser(asAdmin("a"), { sub: "b" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(activeAdmins()).toHaveLength(1);
  });

  it("確かめた管理者が先に外されていたら、次の管理者で確かめ直す", async () => {
    // 一覧は登録順（c → d）。c は一覧を読んだ後、書き込みの前に無効化される
    seed(user("b", ["grader", "admin"]), user("c", ["admin"]), user("d", ["admin"]));
    ddbMock.on(ScanCommand).callsFake(() => {
      const items = [...store.values()].map((u) => ({ ...u }));
      const c = store.get("c");
      if (c) c.disabled = true;
      return { Items: items };
    });
    await removeRole(asAdmin("d"), { sub: "b", role: "admin" });

    expect(transactions.map((t) => t.TransactItems?.[1]?.ConditionCheck?.Key)).toEqual([
      { PK: "USER#c", SK: "PROFILE" },
      { PK: "USER#d", SK: "PROFILE" },
    ]);
    expect(activeAdmins()).toEqual(["d"]);
  });

  it("確かめられる管理者がいなくなっていたら、最後の管理者として拒否する", async () => {
    seed(user("b", ["grader", "admin"]), user("c", ["grader", "admin"]));
    ddbMock.on(ScanCommand).callsFake(() => {
      const items = [...store.values()].map((u) => ({ ...u }));
      const c = store.get("c");
      if (c) c.roles = ["grader"];
      return { Items: items };
    });
    // 実行者 a は一覧にいない（既に admin を外された）。c だけを確かめて失敗する
    await expect(removeRole(asAdmin("a"), { sub: "b", role: "admin" })).rejects.toThrow(
      "最後の 1 人",
    );
    expect(store.get("b")?.roles).toEqual(["grader", "admin"]);
    // 失敗として記録する
    const finished = ddbMock
      .commandCalls(UpdateCommand)
      .map((c) => c.args[0].input)
      .find((i) => i.TableName === "audit");
    expect(finished?.ExpressionAttributeValues?.[":status"]).toBe("FAILED");
  });

  it("有効な管理者が最後の 1 人なら、書き込む前に拒否する（無効化された管理者は数えない）", async () => {
    seed(user("b", ["grader", "admin"]), user("c", ["admin"], { disabled: true }));
    await expect(removeRole(asAdmin("a"), { sub: "b", role: "admin" })).rejects.toThrow(
      "最後の 1 人",
    );
    await expect(disableUser(asAdmin("a"), { sub: "b" })).rejects.toThrow("最後の 1 人");
    expect(transactions).toHaveLength(0);
    // 拒否した操作は記録しない
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("対象のロールが他の操作で変わっていたら、やり直しを求める", async () => {
    seed(user("a", ["admin"]), user("b", ["grader", "admin"]));
    ddbMock.on(TransactWriteCommand).callsFake(() => {
      throw Object.assign(new Error("x"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
      });
    });
    await expect(removeRole(asAdmin("a"), { sub: "b", role: "admin" })).rejects.toThrow(
      "ロールが他の操作で変わりました",
    );
  });

  it("移行前の管理者（role のみ）も、ほかの有効な管理者として確かめられる", async () => {
    const legacy = user("b", []);
    delete legacy.roles;
    seed(user("a", ["admin"]), { ...legacy, role: "admin" }, user("c", ["grader", "admin"]));
    // a は一覧を読んだ時点でもう管理者ではない。確かめられるのは移行前の b だけ
    ddbMock.on(ScanCommand).callsFake(() => {
      const items = [...store.values()].filter(hasAdmin).map((u) => ({ ...u }));
      const a = store.get("a");
      if (a) a.roles = ["grader"];
      return { Items: items };
    });
    await removeRole(asAdmin("a"), { sub: "c", role: "admin" });
    expect(store.get("c")?.roles).toEqual(["grader"]);
  });

  it("スロットリングなど想定外の取り消しの理由は、そのまま投げる（隠さない）", async () => {
    seed(user("a", ["admin"]), user("b", ["admin"]));
    ddbMock.on(TransactWriteCommand).callsFake(() => {
      throw Object.assign(new Error("x"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "ThrottlingError" }, { Code: "None" }],
      });
    });
    const err = await disableUser(asAdmin("a"), { sub: "b" }).catch((e) => e);
    expect(err).not.toBeInstanceOf(StateError);
    expect(err.name).toBe("TransactionCanceledException");
  });

  it("同時に実行された操作と重なったら、やり直しを求める", async () => {
    seed(user("a", ["admin"]), user("b", ["admin"]));
    ddbMock.on(TransactWriteCommand).callsFake(() => {
      throw Object.assign(new Error("x"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "TransactionConflict" }, { Code: "None" }],
      });
    });
    await expect(disableUser(asAdmin("a"), { sub: "b" })).rejects.toThrow("重なりました");
    expect(cognitoMock.commandCalls(AdminDisableUserCommand)).toHaveLength(0);
  });
});

describe("disableUser", () => {
  it("自分自身は無効化できない", async () => {
    seed(user("a", ["grader", "admin"]), user("b", ["admin"]));
    await expect(disableUser(asAdmin("a"), { sub: "a" })).rejects.toBeInstanceOf(ValidationError);
    expect(store.get("a")?.disabled).toBe(false);
  });

  it("管理者でない人の無効化は、ほかの管理者を確かめない", async () => {
    seed(user("a", ["admin"]), user("g", ["grader"]));
    await disableUser(asAdmin("a"), { sub: "g" });
    expect(transactions).toHaveLength(0);
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);
    expect(store.get("g")?.disabled).toBe(true);
  });

  it("DynamoDB → Cognito の順に無効化する（DynamoDB を変えた時点で API は通さない）", async () => {
    seed(user("g", ["grader"]));
    const order: string[] = [];
    ddbMock.on(UpdateCommand, { TableName: "t" }).callsFake(() => {
      order.push("ddb");
      return {};
    });
    cognitoMock.on(AdminDisableUserCommand).callsFake(() => {
      order.push("cognito");
      return {};
    });
    await disableUser(asIam, { email: "g@example.com" });
    expect(order).toEqual(["ddb", "cognito"]);
  });

  it("スーパー管理者（CLI）は最後の管理者でも無効化できる", async () => {
    seed(user("a", ["admin"]));
    await disableUser(asIam, { email: "a@example.com" });
    expect(transactions).toHaveLength(0);
    expect(store.get("a")?.disabled).toBe(true);
  });

  it("Cognito で失敗しても DynamoDB は無効のまま（再実行でそろう）", async () => {
    seed(user("g", ["grader"]));
    cognitoMock.on(AdminDisableUserCommand).rejects(new Error("boom"));
    await expect(disableUser(asIam, { email: "g@example.com" })).rejects.toThrow("boom");
    expect(store.get("g")?.disabled).toBe(true);
    cognitoMock.on(AdminDisableUserCommand).resolves({});
    await disableUser(asIam, { email: "g@example.com" });
    expect(cognitoMock.commandCalls(AdminDisableUserCommand)).toHaveLength(2);
  });
});

describe("setStaffRoles", () => {
  it("付与を先に、削除を後に行う（grader → admin）", async () => {
    seed(user("a", ["admin"]), user("g", ["grader"]));
    const u = await setStaffRoles(asAdmin("a"), { sub: "g", roles: ["admin"] });
    expect(u.roles).toEqual(["admin"]);
    const groups = cognitoMock
      .calls()
      .map(
        (c) =>
          `${c.args[0].constructor.name}:${(c.args[0].input as { GroupName?: string }).GroupName}`,
      );
    expect(groups).toEqual([
      "AdminAddUserToGroupCommand:admin",
      "AdminRemoveUserFromGroupCommand:grader",
    ]);
  });

  it("自分自身の admin を外す指定は、付与する前に拒否する（付与だけが残らない）", async () => {
    seed(user("a", ["admin"]), user("b", ["admin"]));
    await expect(setStaffRoles(asAdmin("a"), { sub: "a", roles: ["grader"] })).rejects.toThrow(
      "自分自身",
    );
    expect(store.get("a")?.roles).toEqual(["admin"]);
    expect(cognitoMock.calls()).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("最後の管理者の admin を外す指定は、付与する前に拒否する", async () => {
    seed(user("b", ["admin"]));
    await expect(setStaffRoles(asAdmin("a"), { sub: "b", roles: ["grader"] })).rejects.toThrow(
      "最後の 1 人",
    );
    expect(store.get("b")?.roles).toEqual(["admin"]);
    expect(cognitoMock.calls()).toHaveLength(0);
  });

  it("候補者のロールは変えられない。無効化された人には付与できない", async () => {
    seed(user("a", ["admin"]), user("c", ["candidate"]), user("d", ["grader"], { disabled: true }));
    await expect(setStaffRoles(asAdmin("a"), { sub: "c", roles: ["grader"] })).rejects.toThrow(
      "候補者",
    );
    await expect(setStaffRoles(asAdmin("a"), { sub: "d", roles: ["admin"] })).rejects.toThrow(
      "無効化",
    );
    expect(cognitoMock.calls()).toHaveLength(0);
  });
});
