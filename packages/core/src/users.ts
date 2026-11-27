import { randomBytes } from "node:crypto";
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminSetUserPasswordCommand,
  type CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { normalizeEmail } from "./email.js";
import { StateError, ValidationError } from "./errors.js";
import { GSI1, keys } from "./keys.js";
import { isRole, type Role, rolesProblem, sortRoles } from "./roles.js";

export interface UserDeps {
  cognito: CognitoIdentityProviderClient;
  ddb: DynamoDBDocumentClient;
  userPoolId: string;
  tableName: string;
  now?: () => Date;
}

export interface UserProfile {
  sub: string;
  email: string;
  name: string;
  /** 1 つ以上。grader と admin は兼任できる。candidate は単独（docs/design.md §14.2） */
  roles: Role[];
  disabled: boolean;
  createdAt: string;
}

export class UserAlreadyExistsError extends Error {
  constructor(email: string) {
    super(`既に登録済みのメールアドレスです: ${email}`);
  }
}

export class UserNotFoundError extends Error {
  constructor(email: string) {
    super(`登録されていないメールアドレスです: ${email}`);
  }
}

/**
 * 候補者・採点者・管理者を登録する。
 * - Cognito: 招待メールは送らず（SUPPRESS）、email_verified=true で作成
 * - ログインは Email OTP のみを想定。Cognito の仕様上パスワード要素は無効化できないため、
 *   誰にも知らせない十分に長いランダムパスワードを設定して CONFIRMED 状態にする
 * - DynamoDB: User プロフィールを保存（Cognito 作成後に失敗した場合は Cognito 側を巻き戻す）
 */
export async function registerUser(
  deps: UserDeps,
  input: { email: string; name: string; roles: Role[] },
): Promise<UserProfile> {
  const email = normalizeEmail(input.email);
  const name = input.name.trim();
  if (!name) throw new Error("氏名は必須です");
  const problem = rolesProblem(input.roles);
  if (problem) throw new ValidationError(problem);
  const roles = sortRoles(input.roles);

  if (await findUserByEmail(deps, email)) throw new UserAlreadyExistsError(email);

  let sub: string;
  try {
    const created = await deps.cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: deps.userPoolId,
        Username: email,
        MessageAction: "SUPPRESS",
        UserAttributes: [
          { Name: "email", Value: email },
          { Name: "email_verified", Value: "true" },
          { Name: "name", Value: name },
        ],
      }),
    );
    const found = created.User?.Attributes?.find((a) => a.Name === "sub")?.Value;
    if (!found) throw new Error("Cognito から sub を取得できませんでした");
    sub = found;
  } catch (e) {
    if (e instanceof Error && e.name === "UsernameExistsException") {
      throw new UserAlreadyExistsError(email);
    }
    throw e;
  }

  const profile: UserProfile = {
    sub,
    email,
    name,
    roles,
    disabled: false,
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
  };

  try {
    await deps.cognito.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: deps.userPoolId,
        Username: email,
        Password: unusablePassword(),
        Permanent: true,
      }),
    );
    for (const role of roles) {
      await deps.cognito.send(
        new AdminAddUserToGroupCommand({
          UserPoolId: deps.userPoolId,
          Username: email,
          GroupName: role,
        }),
      );
    }
    await deps.ddb.send(
      new PutCommand({
        TableName: deps.tableName,
        Item: { ...keys.user(sub), ...keys.userByEmail(email), type: "User", ...profile },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  } catch (e) {
    try {
      await deps.cognito.send(
        new AdminDeleteUserCommand({ UserPoolId: deps.userPoolId, Username: email }),
      );
    } catch {
      // 巻き戻し失敗時は元のエラーを優先して返す（Cognito に残ったユーザーは再登録時に検知される）
    }
    throw e;
  }

  return profile;
}

/** Cognito の sub（JWT の sub クレーム）からプロフィールを取得する。API の認可で使う */
export async function getUserBySub(
  deps: Pick<UserDeps, "ddb" | "tableName">,
  sub: string,
): Promise<UserProfile | undefined> {
  const res = await deps.ddb.send(
    new GetCommand({ TableName: deps.tableName, Key: keys.user(sub), ConsistentRead: true }),
  );
  return res.Item ? toProfile(res.Item) : undefined;
}

export async function findUserByEmail(
  deps: Pick<UserDeps, "ddb" | "tableName">,
  rawEmail: string,
): Promise<UserProfile | undefined> {
  const email = normalizeEmail(rawEmail);
  const res = await deps.ddb.send(
    new QueryCommand({
      TableName: deps.tableName,
      IndexName: GSI1,
      KeyConditionExpression: "GSI1PK = :pk AND GSI1SK = :sk",
      ExpressionAttributeValues: {
        ":pk": keys.userByEmail(email).GSI1PK,
        ":sk": keys.userByEmail(email).GSI1SK,
      },
    }),
  );
  const item = res.Items?.[0];
  return item ? toProfile(item) : undefined;
}

export async function listUsers(
  deps: Pick<UserDeps, "ddb" | "tableName">,
  role?: Role,
): Promise<UserProfile[]> {
  // MVP の件数（数百）なら Scan で十分。件数が増えたらロール別 GSI を追加する
  const users: UserProfile[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await deps.ddb.send(
      new ScanCommand({
        TableName: deps.tableName,
        // 移行前（role のみ）のアイテムも拾う（§14.2）
        FilterExpression: role ? "#t = :t AND (contains(#rs, :r) OR #r = :r)" : "#t = :t",
        ExpressionAttributeNames: role
          ? { "#t": "type", "#r": "role", "#rs": "roles" }
          : { "#t": "type" },
        ExpressionAttributeValues: role ? { ":t": "User", ":r": role } : { ":t": "User" },
        ExclusiveStartKey: startKey,
      }),
    );
    users.push(...(res.Items ?? []).map(toProfile));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return users.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function disableUser(deps: UserDeps, rawEmail: string): Promise<UserProfile> {
  const user = await findUserByEmail(deps, rawEmail);
  if (!user) throw new UserNotFoundError(rawEmail);
  await deps.cognito.send(
    new AdminDisableUserCommand({ UserPoolId: deps.userPoolId, Username: user.email }),
  );
  await deps.ddb.send(
    new UpdateCommand({
      TableName: deps.tableName,
      Key: keys.user(user.sub),
      UpdateExpression: "SET disabled = :true",
      ExpressionAttributeValues: { ":true": true },
    }),
  );
  return { ...user, disabled: true };
}

/** 移行前のアイテム（role のみ）は [role] として読む */
export function rolesOf(item: Record<string, unknown>): Role[] {
  if (Array.isArray(item.roles)) return sortRoles(item.roles.filter(isRole));
  return isRole(item.role) ? [item.role] : [];
}

function toProfile(item: Record<string, unknown>): UserProfile {
  return {
    sub: String(item.sub),
    email: String(item.email),
    name: String(item.name),
    roles: rolesOf(item),
    disabled: Boolean(item.disabled),
    createdAt: String(item.createdAt),
  };
}

/** 誰にも開示しない 64 文字のランダムパスワード（Cognito の既定ポリシーを満たす文字種を含む） */
function unusablePassword(): string {
  return `${randomBytes(48).toString("base64url")}Aa1!`;
}

/** ロールの付与・削除を行う人。管理者（画面）なら sub を渡し、自分自身・最後の管理者の保護を効かせる */
export interface RoleActor {
  /** 管理者（Cognito ユーザー）の sub。スーパー管理者（CLI）は省略 */
  adminSub?: string;
}

/**
 * ロールを付与する（§14.3）。Cognito（グループ）→ DynamoDB の順に行い、DynamoDB で失敗したら Cognito を戻す。
 * どちらか片方だけ成功しても、API は両方にあるロールしか認めないため権限は残らない。
 */
export async function addRole(
  deps: UserDeps,
  input: { email: string; role: Role },
): Promise<UserProfile> {
  const user = await findUserByEmail(deps, input.email);
  if (!user) throw new UserNotFoundError(input.email);
  if (user.roles.includes(input.role)) return user;
  const next = sortRoles([...user.roles, input.role]);
  const problem = rolesProblem(next);
  if (problem) throw new ValidationError(problem);

  await deps.cognito.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: deps.userPoolId,
      Username: user.email,
      GroupName: input.role,
    }),
  );
  try {
    await updateRoles(deps, user, next);
  } catch (e) {
    try {
      await deps.cognito.send(
        new AdminRemoveUserFromGroupCommand({
          UserPoolId: deps.userPoolId,
          Username: user.email,
          GroupName: input.role,
        }),
      );
    } catch {
      // 戻せなくても、DynamoDB の roles にないロールは API で認められない（元のエラーを優先する）
    }
    throw e;
  }
  return { ...user, roles: next };
}

/**
 * ロールを外す（§14.3）。DynamoDB → Cognito の順に行う（DynamoDB を変えた時点で即時に無効になる）。
 * 最後のロールは外せない（利用を止めるときは無効化する）。
 */
export async function removeRole(
  deps: UserDeps,
  input: { email: string; role: Role },
  actor: RoleActor = {},
): Promise<UserProfile> {
  const user = await findUserByEmail(deps, input.email);
  if (!user) throw new UserNotFoundError(input.email);
  if (!user.roles.includes(input.role)) return user;
  const next = user.roles.filter((r) => r !== input.role);
  if (next.length === 0) {
    throw new ValidationError("最後のロールは外せません。利用を止める場合は無効化してください");
  }
  if (input.role === "admin" && actor.adminSub !== undefined) {
    await assertAdminRemovable(deps, user, actor.adminSub);
  }

  await updateRoles(deps, user, next);
  await deps.cognito.send(
    new AdminRemoveUserFromGroupCommand({
      UserPoolId: deps.userPoolId,
      Username: user.email,
      GroupName: input.role,
    }),
  );
  return { ...user, roles: next };
}

/**
 * 管理者（画面）による admin の削除・無効化の保護（§14.1）。
 * 自分自身は不可。有効な管理者が最後の 1 人なら不可（スーパー管理者は CLI で常に操作できる）。
 */
export async function assertAdminRemovable(
  deps: Pick<UserDeps, "ddb" | "tableName">,
  target: UserProfile,
  actorSub: string,
): Promise<void> {
  if (target.sub === actorSub) {
    throw new ValidationError("自分自身の管理者の権限は外せません");
  }
  if (!target.roles.includes("admin") || target.disabled) return;
  const admins = (await listUsers(deps, "admin")).filter((u) => !u.disabled);
  if (admins.every((u) => u.sub === target.sub)) {
    throw new StateError("INVALID", "最後の管理者の権限は外せません");
  }
}

/** 読み込んだ時点の roles から変わっていなければ更新する。移行前の role は削除する */
async function updateRoles(deps: UserDeps, user: UserProfile, next: Role[]): Promise<void> {
  const single = user.roles.length === 1 ? { ":single": user.roles[0] } : {};
  try {
    await deps.ddb.send(
      new UpdateCommand({
        TableName: deps.tableName,
        Key: keys.user(user.sub),
        UpdateExpression: "SET #rs = :next REMOVE #r",
        ConditionExpression:
          user.roles.length === 1
            ? "#rs = :prev OR (attribute_not_exists(#rs) AND #r = :single)"
            : "#rs = :prev",
        ExpressionAttributeNames: { "#rs": "roles", "#r": "role" },
        ExpressionAttributeValues: { ":next": next, ":prev": user.roles, ...single },
      }),
    );
  } catch (e) {
    if (e instanceof Error && e.name === "ConditionalCheckFailedException") {
      throw new StateError("INVALID", "ロールが他の操作で変わりました。もう一度実行してください");
    }
    throw e;
  }
}

/**
 * 移行前のアイテム（role のみ）を roles に書き換える（§14.2。Step 7 のデプロイ時に 1 回実行）。
 * 何度実行してもよい。
 */
export async function migrateRoles(
  deps: Pick<UserDeps, "ddb" | "tableName">,
): Promise<{ migrated: number; skipped: number }> {
  let migrated = 0;
  let skipped = 0;
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await deps.ddb.send(
      new ScanCommand({
        TableName: deps.tableName,
        FilterExpression: "#t = :t AND attribute_not_exists(#rs)",
        ExpressionAttributeNames: { "#t": "type", "#rs": "roles" },
        ExpressionAttributeValues: { ":t": "User" },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of res.Items ?? []) {
      if (!isRole(item.role)) {
        skipped += 1;
        continue;
      }
      try {
        await deps.ddb.send(
          new UpdateCommand({
            TableName: deps.tableName,
            Key: keys.user(String(item.sub)),
            UpdateExpression: "SET #rs = :roles REMOVE #r",
            ConditionExpression: "attribute_not_exists(#rs) AND #r = :role",
            ExpressionAttributeNames: { "#rs": "roles", "#r": "role" },
            ExpressionAttributeValues: { ":roles": [item.role], ":role": item.role },
          }),
        );
        migrated += 1;
      } catch (e) {
        // 並行して移行・更新された
        if (e instanceof Error && e.name === "ConditionalCheckFailedException") skipped += 1;
        else throw e;
      }
    }
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return { migrated, skipped };
}
