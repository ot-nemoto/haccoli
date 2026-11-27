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
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { type AuditDeps, withAudit } from "./audit.js";
import { isConditionFailure, transactionFailureCodes } from "./ddb-errors.js";
import { normalizeEmail } from "./email.js";
import { DomainError, NotFoundError, StateError, ValidationError } from "./errors.js";
import { GSI1, keys } from "./keys.js";
import { type Page, readPage } from "./paging.js";
import { isRole, type Role, rolesProblem, sortRoles } from "./roles.js";

export interface UserDeps {
  cognito: CognitoIdentityProviderClient;
  ddb: DynamoDBDocumentClient;
  userPoolId: string;
  tableName: string;
  now?: () => Date;
}

/** 記録を伴う変更操作の依存（監査ログ。docs/design.md §14.4） */
export type AuditedUserDeps = UserDeps & AuditDeps;

export interface UserProfile {
  sub: string;
  email: string;
  name: string;
  /** 1 つ以上。grader と admin は兼任できる。candidate は単独（docs/design.md §14.2） */
  roles: Role[];
  disabled: boolean;
  createdAt: string;
}

export class UserAlreadyExistsError extends DomainError {
  constructor(email: string) {
    super(`既に登録済みのメールアドレスです: ${email}`);
  }
}

export class UserNotFoundError extends NotFoundError {
  constructor(ref: UserRef) {
    super(
      "email" in ref
        ? `登録されていないメールアドレスです: ${ref.email}`
        : `利用者が見つかりません: ${ref.sub}`,
    );
  }
}

/** 変更する利用者の指定。CLI はメールアドレス、管理者 API は sub で指定する */
export type UserRef = { email: string } | { sub: string };

async function resolveUser(
  deps: Pick<UserDeps, "ddb" | "tableName">,
  ref: UserRef,
): Promise<UserProfile> {
  const user =
    "email" in ref ? await findUserByEmail(deps, ref.email) : await getUserBySub(deps, ref.sub);
  if (!user) throw new UserNotFoundError(ref);
  return user;
}

/**
 * 候補者・採点者・管理者を登録する。
 * - Cognito: 招待メールは送らず（SUPPRESS）、email_verified=true で作成
 * - ログインは Email OTP のみを想定。Cognito の仕様上パスワード要素は無効化できないため、
 *   誰にも知らせない十分に長いランダムパスワードを設定して CONFIRMED 状態にする
 * - DynamoDB: User プロフィールを保存（Cognito 作成後に失敗した場合は Cognito 側を巻き戻す）
 */
export async function registerUser(
  deps: AuditedUserDeps,
  input: { email: string; name: string; roles: Role[] },
): Promise<UserProfile> {
  const email = normalizeEmail(input.email);
  const name = input.name.trim();
  if (!name) throw new ValidationError("氏名は必須です");
  const problem = rolesProblem(input.roles);
  if (problem) throw new ValidationError(problem);
  const roles = sortRoles(input.roles);

  if (await findUserByEmail(deps, email)) throw new UserAlreadyExistsError(email);

  // sub は Cognito で作成するまで決まらないため、対象は成功時に記録する
  return withAudit(
    deps,
    { action: "user.add", detail: { roles } },
    () => createUser(deps, { email, name, roles }),
    (user) => ({ target: { type: "user", id: user.sub } }),
  );
}

async function createUser(
  deps: UserDeps,
  { email, name, roles }: { email: string; name: string; roles: Role[] },
): Promise<UserProfile> {
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

/** 利用者の一覧（すべて、登録順）。CLI と、最後の管理者の確認で使う */
export async function listUsers(
  deps: Pick<UserDeps, "ddb" | "tableName">,
  role?: Role,
): Promise<UserProfile[]> {
  // MVP の件数（数百）なら Scan で十分。件数が増えたらロール別 GSI を追加する
  const fetch = userScan(deps, role);
  const users: UserProfile[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await fetch(startKey);
    users.push(...(res.Items ?? []).map(toProfile));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return users.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * 利用者の一覧（ページごと）。管理者 API で使う。
 * Scan の順（登録順ではない）で返す。ページをまたいで並べ替えられないため
 */
export async function listUserPage(
  deps: Pick<UserDeps, "ddb" | "tableName">,
  opts: { role?: Role; limit?: number; cursor?: string },
): Promise<Page<UserProfile>> {
  const page = await readPage(userScan(deps, opts.role), {
    limit: opts.limit,
    cursor: opts.cursor,
    isValidKey: (key) => key.PK.startsWith("USER#") && key.SK === "PROFILE",
  });
  return { ...page, items: page.items.map(toProfile) };
}

function userScan(deps: Pick<UserDeps, "ddb" | "tableName">, role: Role | undefined) {
  return (startKey: Record<string, unknown> | undefined) =>
    deps.ddb.send(
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
}

/**
 * 無効化する。DynamoDB → Cognito の順に行う（§14.3）。API は毎回 DynamoDB を照合するため、
 * DynamoDB を変えた時点で即時に無効になる。Cognito で失敗しても再実行でそろう。
 * 管理者（画面）による操作では、自分自身・最後の有効な管理者を無効化させない（§14.1）。
 */
export async function disableUser(deps: AuditedUserDeps, ref: UserRef): Promise<UserProfile> {
  const user = await resolveUser(deps, ref);
  const guard =
    deps.actor.type === "admin"
      ? await adminRemovalGuard(deps, user, deps.actor.sub, "disable")
      : undefined;
  return withAudit(
    deps,
    {
      action: "user.disable",
      target: { type: "user", id: user.sub },
      detail: { roles: user.roles },
    },
    async () => {
      try {
        await guardedUpdate(
          deps,
          {
            Key: keys.user(user.sub),
            UpdateExpression: "SET disabled = :true",
            ConditionExpression: "attribute_exists(PK)",
            ExpressionAttributeValues: { ":true": true },
          },
          guard,
        );
      } catch (e) {
        if (isConditionFailure(e)) throw new UserNotFoundError({ sub: user.sub });
        throw e;
      }
      await deps.cognito.send(
        new AdminDisableUserCommand({ UserPoolId: deps.userPoolId, Username: user.email }),
      );
      return { ...user, disabled: true };
    },
  );
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

/**
 * ロールを付与する（§14.3）。Cognito（グループ）→ DynamoDB の順に行い、DynamoDB で失敗したら Cognito を戻す。
 * どちらか片方だけ成功しても、API は両方にあるロールしか認めないため権限は残らない。
 * 付与済みでもグループはそろえるので、途中で失敗した場合は再実行で直る。
 */
export async function addRole(
  deps: AuditedUserDeps,
  input: UserRef & { role: Role },
): Promise<UserProfile> {
  const user = await resolveUser(deps, input);
  if (user.disabled) throw new ValidationError(`無効化された利用者です: ${user.email}`);
  const problem = rolesProblem(sortRoles([...user.roles, input.role]));
  if (problem && !user.roles.includes(input.role)) throw new ValidationError(problem);

  return withAudit(
    deps,
    {
      action: "user.roles",
      target: { type: "user", id: user.sub },
      detail: { added: input.role, rolesBefore: user.roles },
    },
    () => grantRole(deps, user, input.role),
    (after) => ({ detail: { rolesAfter: after.roles, changed: changedRoles(user, after) } }),
  );
}

async function grantRole(deps: UserDeps, user: UserProfile, role: Role): Promise<UserProfile> {
  await groupCommand(deps, "add", user.email, role);
  if (user.roles.includes(role)) return user;
  try {
    const roles = await updateRoles(deps, user.sub, (cur) => [...cur, role]);
    return { ...user, roles };
  } catch (e) {
    // 同時に付与されて DynamoDB に入っていれば成功とし、グループは外さない
    const latest = await getUserBySub(deps, user.sub).catch(() => undefined);
    if (latest?.roles.includes(role)) return latest;
    try {
      await groupCommand(deps, "remove", user.email, role);
    } catch {
      // 戻せなくても、DynamoDB の roles にないロールは API で認められない（元のエラーを優先する）
    }
    throw e;
  }
}

/**
 * ロールを外す（§14.3）。DynamoDB → Cognito の順に行う（DynamoDB を変えた時点で即時に無効になる）。
 * 最後のロールは外せない（利用を止めるときは無効化する）。
 * DynamoDB から外れていてもグループは外すので、途中で失敗した場合は再実行で直る。
 */
export async function removeRole(
  deps: AuditedUserDeps,
  input: UserRef & { role: Role },
): Promise<UserProfile> {
  const user = await resolveUser(deps, input);
  const held = user.roles.includes(input.role);
  if (held && user.roles.length === 1) throw lastRole();
  // 管理者（画面）による操作では、自分自身・最後の管理者の admin を外させない（§14.1）
  const guard =
    held && input.role === "admin" && deps.actor.type === "admin"
      ? await adminRemovalGuard(deps, user, deps.actor.sub, "role")
      : undefined;

  return withAudit(
    deps,
    {
      action: "user.roles",
      target: { type: "user", id: user.sub },
      detail: { removed: input.role, rolesBefore: user.roles },
    },
    async () => {
      if (!held) {
        await groupCommand(deps, "remove", user.email, input.role);
        return user;
      }
      const roles = await updateRoles(
        deps,
        user.sub,
        (cur) => {
          const next = cur.filter((r) => r !== input.role);
          if (next.length === 0) throw lastRole();
          return next;
        },
        guard,
      );
      await groupCommand(deps, "remove", user.email, input.role);
      return { ...user, roles };
    },
    (after) => ({ detail: { rolesAfter: after.roles, changed: changedRoles(user, after) } }),
  );
}

/**
 * 採点者・管理者のロールを、指定した組み合わせにする（管理者 API の PUT /admin/users/{sub}/roles）。
 * 付与を先に、削除を後に行う（例: grader → admin でも、最後のロールを外す途中の状態にならない）。
 * 付与・削除はそれぞれ監査ログに記録する。
 *
 * 管理者（画面）が admin を外す場合は、付与の前に自分自身・最後の管理者のチェックを済ませる。
 * 削除で拒否されるのに付与だけが残る、ということを避けるため（削除の時点の確認は removeRole が
 * トランザクションで行う）。
 */
export async function setStaffRoles(
  deps: AuditedUserDeps,
  input: { sub: string; roles: Exclude<Role, "candidate">[] },
): Promise<UserProfile> {
  const user = await resolveUser(deps, { sub: input.sub });
  if (user.roles.includes("candidate")) {
    throw new ValidationError("候補者のロールは変更できません");
  }
  const wanted = sortRoles(input.roles);
  const problem = rolesProblem(wanted);
  if (problem) throw new ValidationError(problem);
  const adds = wanted.filter((r) => !user.roles.includes(r));
  const removes = user.roles.filter((r) => !wanted.includes(r));
  if (adds.length > 0 && user.disabled) {
    throw new ValidationError(`無効化された利用者です: ${user.email}`);
  }
  if (removes.includes("admin") && deps.actor.type === "admin") {
    await adminRemovalGuard(deps, user, deps.actor.sub, "role");
  }

  let current = user;
  for (const role of adds) current = await addRole(deps, { sub: user.sub, role });
  for (const role of removes) current = await removeRole(deps, { sub: user.sub, role });
  return current;
}

/**
 * DynamoDB のロールが変わったか。付与済み・削除済みでも Cognito のグループはそろえるため記録は残すが、
 * 実際の変更と区別できるようにする
 */
const changedRoles = (before: UserProfile, after: UserProfile) =>
  before.roles.join(",") !== after.roles.join(",");

const lastRole = () =>
  new ValidationError("最後のロールは外せません。利用を止める場合は無効化してください");

async function groupCommand(
  deps: UserDeps,
  op: "add" | "remove",
  email: string,
  role: Role,
): Promise<void> {
  const input = { UserPoolId: deps.userPoolId, Username: email, GroupName: role };
  await deps.cognito.send(
    op === "add"
      ? new AdminAddUserToGroupCommand(input)
      : new AdminRemoveUserFromGroupCommand(input),
  );
}

/**
 * 管理者（画面）による admin の削除・無効化の保護（§14.1）。スーパー管理者（CLI）には効かせない。
 * - 自分自身は不可（自分の admin を外す・自分を無効化する）
 * - 対象が有効な管理者なら、ほかに有効な管理者がいなければ不可
 *
 * ほかの有効な管理者（の sub）を返す。更新するときは、そのうち 1 人がまだ有効な管理者であることを
 * 同じトランザクションで確かめる（guardedUpdate）。数えてから更新するまでの間に、
 * 管理者同士で互いに外し合っても 0 人にならない。保護が要らなければ undefined。
 */
async function adminRemovalGuard(
  deps: Pick<UserDeps, "ddb" | "tableName">,
  target: UserProfile,
  actorSub: string,
  op: "role" | "disable",
): Promise<string[] | undefined> {
  if (target.sub === actorSub) {
    throw new ValidationError(
      op === "role" ? "自分自身の管理者の権限は外せません" : "自分自身は無効化できません",
    );
  }
  if (!target.roles.includes("admin") || target.disabled) return undefined;
  const others = (await listUsers(deps, "admin"))
    .filter((u) => !u.disabled && u.sub !== target.sub)
    .map((u) => u.sub);
  if (others.length === 0) throw lastAdmin();
  return others;
}

const lastAdmin = () =>
  new StateError(
    "INVALID",
    "有効な管理者が最後の 1 人のため、管理者の権限を外す・無効化することはできません",
  );

/**
 * 有効な管理者であることの条件（最後の管理者の保護で、ほかの管理者に使う）。
 * 一覧（listUsers）と同じく、移行前のアイテム（role のみ）も管理者として認める
 */
const ACTIVE_ADMIN = {
  ConditionExpression:
    "(contains(#rs, :admin) OR #r = :admin) AND (attribute_not_exists(#d) OR #d = :false)",
  ExpressionAttributeNames: { "#rs": "roles", "#r": "role", "#d": "disabled" },
  ExpressionAttributeValues: { ":admin": "admin", ":false": false },
};

interface ProfileUpdate {
  Key: { PK: string; SK: string };
  UpdateExpression: string;
  ConditionExpression: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
}

/**
 * 利用者のプロフィールを更新する。guard（ほかの有効な管理者の sub）があれば、
 * そのうち 1 人がまだ有効な管理者であることを同じトランザクションで確かめる。
 * 確かめた管理者が先に外されていたら、次の管理者で試す。全員が外されていれば最後の管理者として拒否する。
 *
 * 互いに外し合う 2 つの操作は、どちらも相手のアイテムを確かめ・自分の対象を更新するため、
 * 同じ 2 件のアイテムに触れる。DynamoDB のトランザクションは直列化されるので、片方は必ず失敗する。
 *
 * @throws 対象の条件（ConditionExpression）を満たさないときは ConditionalCheckFailedException
 */
async function guardedUpdate(
  deps: Pick<UserDeps, "ddb" | "tableName">,
  update: ProfileUpdate,
  guard: string[] | undefined,
): Promise<void> {
  if (!guard) {
    await deps.ddb.send(new UpdateCommand({ TableName: deps.tableName, ...update }));
    return;
  }
  for (const other of guard) {
    try {
      await deps.ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            { Update: { TableName: deps.tableName, ...update } },
            {
              ConditionCheck: { TableName: deps.tableName, Key: keys.user(other), ...ACTIVE_ADMIN },
            },
          ],
        }),
      );
      return;
    } catch (e) {
      const codes = transactionFailureCodes(e);
      if (!codes) throw e;
      if (codes[0] === "ConditionalCheckFailed") {
        throw Object.assign(new Error("対象の利用者が変わりました"), {
          name: "ConditionalCheckFailedException",
        });
      }
      // 確かめた管理者が、外された・無効化された。次の管理者で試す
      if (codes[1] === "ConditionalCheckFailed") continue;
      // 同時に実行された操作と重なった
      if (codes.includes("TransactionConflict")) {
        throw new StateError("INVALID", "他の操作と重なりました。もう一度実行してください");
      }
      // スロットリングなど想定外の理由は隠さない（API では 500 にし、アラームで気づけるようにする）
      throw e;
    }
  }
  throw lastAdmin();
}

/**
 * ロールを読み直して更新する。保存されているままの値（順序・未知の値を含む。移行前は role）を条件にし、
 * 読んだ後に他の操作で変わっていたら失敗させる。移行前の role は削除する。
 */
async function updateRoles(
  deps: UserDeps,
  sub: string,
  change: (current: Role[]) => Role[],
  guard?: string[],
): Promise<Role[]> {
  const res = await deps.ddb.send(
    new GetCommand({ TableName: deps.tableName, Key: keys.user(sub), ConsistentRead: true }),
  );
  if (!res.Item) throw new StateError("INVALID", "利用者が見つかりません");
  const next = sortRoles([...new Set(change(rolesOf(res.Item)))]);
  const problem = rolesProblem(next);
  if (problem) throw new ValidationError(problem);

  const stored = res.Item.roles;
  const condition = Array.isArray(stored)
    ? { expr: "#rs = :prev", values: { ":prev": stored } }
    : res.Item.role !== undefined
      ? { expr: "attribute_not_exists(#rs) AND #r = :prev", values: { ":prev": res.Item.role } }
      : { expr: "attribute_not_exists(#rs) AND attribute_not_exists(#r)", values: {} };
  try {
    await guardedUpdate(
      deps,
      {
        Key: keys.user(sub),
        UpdateExpression: "SET #rs = :next REMOVE #r",
        ConditionExpression: condition.expr,
        ExpressionAttributeNames: { "#rs": "roles", "#r": "role" },
        ExpressionAttributeValues: { ":next": next, ...condition.values },
      },
      guard,
    );
  } catch (e) {
    if (isConditionFailure(e)) {
      throw new StateError("INVALID", "ロールが他の操作で変わりました。もう一度実行してください");
    }
    throw e;
  }
  return next;
}

/**
 * 移行前のアイテム（role のみ）を roles に書き換える（§14.2。Step 7 のデプロイ時に 1 回実行）。
 * 何度実行してもよい。
 */
export async function migrateRoles(
  deps: Pick<UserDeps, "ddb" | "tableName"> & AuditDeps,
): Promise<{ migrated: number; skipped: number }> {
  return withAudit(
    deps,
    { action: "user.migrate-roles" },
    () => migrateRoleItems(deps),
    (res) => ({ detail: { migrated: res.migrated, skipped: res.skipped } }),
  );
}

async function migrateRoleItems(
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
