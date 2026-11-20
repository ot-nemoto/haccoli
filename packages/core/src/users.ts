import { randomBytes } from "node:crypto";
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
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
import { GSI1, keys } from "./keys.js";
import type { Role } from "./roles.js";

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
  role: Role;
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
 * 候補者・採点者を登録する。
 * - Cognito: 招待メールは送らず（SUPPRESS）、email_verified=true で作成
 * - ログインは Email OTP のみを想定。Cognito の仕様上パスワード要素は無効化できないため、
 *   誰にも知らせない十分に長いランダムパスワードを設定して CONFIRMED 状態にする
 * - DynamoDB: User プロフィールを保存（Cognito 作成後に失敗した場合は Cognito 側を巻き戻す）
 */
export async function registerUser(
  deps: UserDeps,
  input: { email: string; name: string; role: Role },
): Promise<UserProfile> {
  const email = normalizeEmail(input.email);
  const name = input.name.trim();
  if (!name) throw new Error("氏名は必須です");

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
    role: input.role,
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
    await deps.cognito.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: deps.userPoolId,
        Username: email,
        GroupName: input.role,
      }),
    );
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
        FilterExpression: role ? "#t = :t AND #r = :r" : "#t = :t",
        ExpressionAttributeNames: role ? { "#t": "type", "#r": "role" } : { "#t": "type" },
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

function toProfile(item: Record<string, unknown>): UserProfile {
  return {
    sub: String(item.sub),
    email: String(item.email),
    name: String(item.name),
    role: item.role as Role,
    disabled: Boolean(item.disabled),
    createdAt: String(item.createdAt),
  };
}

/** 誰にも開示しない 64 文字のランダムパスワード（Cognito の既定ポリシーを満たす文字種を含む） */
function unusablePassword(): string {
  return `${randomBytes(48).toString("base64url")}Aa1!`;
}
