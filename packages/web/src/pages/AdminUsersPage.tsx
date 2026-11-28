import {
  type AdminCreateUserRequest,
  type AdminUser,
  type AdminUserPage,
  ROLE_LABELS,
  type Role,
  type StaffRole,
} from "@haccoli/shared";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { messageOf } from "../api.js";
import { useAuth } from "../auth/AuthContext.js";
import { ROLE_ROUTES } from "../auth/roles.js";
import { useApi } from "../auth/useApi.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { rolesChange, rolesLabel, withQuery } from "../lib/admin.js";
import { formatJst } from "../lib/format.js";
import { AdminLayout } from "./AdminLayout.js";

const STAFF_ROLES: StaffRole[] = ["grader", "admin"];

/** 利用者の一覧・登録・ロールの変更・無効化（docs/design.md §14.7 /admin/users） */
export function AdminUsersPage() {
  const api = useApi();
  const [role, setRole] = useState<Role | "">("");
  const [items, setItems] = useState<AdminUser[]>();
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  /** 最後に出した読み込み。絞り込みを変えたとき、前の読み込みの結果で上書きしない */
  const latest = useRef(0);

  const load = useCallback(
    async (opts: { role: Role | ""; cursor?: string }) => {
      const id = ++latest.current;
      setLoading(true);
      setError(undefined);
      try {
        const page = await api<AdminUserPage>(
          withQuery("/admin/users", { role: opts.role, cursor: opts.cursor }),
        );
        if (id !== latest.current) return;
        setItems((prev) => (opts.cursor ? [...(prev ?? []), ...page.items] : page.items));
        setCursor(page.cursor);
      } catch (e) {
        if (id === latest.current) setError(messageOf(e));
      } finally {
        if (id === latest.current) setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    void load({ role });
  }, [load, role]);

  /** 1 行の結果を一覧に反映する */
  const replace = (user: AdminUser) =>
    setItems((prev) => prev?.map((u) => (u.sub === user.sub ? user : u)));

  return (
    <AdminLayout>
      <h1>利用者</h1>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <RegisterForm
        onRegistered={(user) => {
          setItems((prev) => [user, ...(prev ?? [])]);
          setNotice(
            `${user.name} さんを${rolesLabel(user.roles)}として登録しました。ログイン URL（${loginUrl(user.roles)}）を連絡してください。招待メールは送りません。`,
          );
        }}
      />

      <div className="toolbar">
        <label className="inline">
          ロール
          <select value={role} onChange={(e) => setRole(e.target.value as Role | "")}>
            <option value="">すべて</option>
            {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!items && loading && <p>読み込み中…</p>}
      {items?.length === 0 && <p>該当する利用者はいません。</p>}
      {items && items.length > 0 && (
        <table className="list">
          <thead>
            <tr>
              <th>氏名</th>
              <th>メールアドレス</th>
              <th>ロール</th>
              <th>状態</th>
              <th>登録日時</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((u) => (
              <UserRow key={u.sub} user={u} onChanged={replace} onNotice={setNotice} />
            ))}
          </tbody>
        </table>
      )}
      {cursor && (
        <p>
          <button
            type="button"
            className="secondary"
            disabled={loading}
            onClick={() => void load({ role, cursor })}
          >
            {loading ? "読み込み中…" : "さらに読み込む"}
          </button>
        </p>
      )}
    </AdminLayout>
  );
}

function loginUrl(roles: readonly Role[]): string {
  // 候補者は候補者の画面、それ以外は採点者の画面を優先して案内する（管理者のみなら管理画面）
  const role: Role = roles.includes("candidate")
    ? "candidate"
    : roles.includes("grader")
      ? "grader"
      : "admin";
  return `${window.location.origin}${ROLE_ROUTES[role].login}`;
}

function RegisterForm(props: { onRegistered: (user: AdminUser) => void }) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"candidate" | "staff">("candidate");
  const [staffRoles, setStaffRoles] = useState<StaffRole[]>(["grader"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (!open) {
    return (
      <p>
        <button type="button" onClick={() => setOpen(true)}>
          利用者を登録する
        </button>
      </p>
    );
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      const body: AdminCreateUserRequest = {
        email: email.trim(),
        name: name.trim(),
        roles: kind === "candidate" ? ["candidate"] : staffRoles,
      };
      const user = await api<AdminUser>("/admin/users", {
        method: "POST",
        body: JSON.stringify(body),
      });
      props.onRegistered(user);
      setEmail("");
      setName("");
      setOpen(false);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel" onSubmit={onSubmit} aria-label="利用者の登録">
      <h2>利用者を登録する</h2>
      <p className="muted">
        メールアドレスの誤りに注意してください。存在しないアドレスにパスコードを送ると、メールの送信が止まる原因になります。
      </p>
      <label>
        メールアドレス
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
        />
      </label>
      <label>
        氏名
        <input required value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
      </label>
      <fieldset className="choices">
        <legend>種類</legend>
        <label className="choice">
          <input
            type="radio"
            name="kind"
            checked={kind === "candidate"}
            onChange={() => setKind("candidate")}
            disabled={busy}
          />
          候補者
        </label>
        <label className="choice">
          <input
            type="radio"
            name="kind"
            checked={kind === "staff"}
            onChange={() => setKind("staff")}
            disabled={busy}
          />
          採点者・管理者
        </label>
        {kind === "staff" && (
          <StaffRoleChoices value={staffRoles} onChange={setStaffRoles} disabled={busy} />
        )}
      </fieldset>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="confirm-actions">
        <button type="submit" disabled={busy || (kind === "staff" && staffRoles.length === 0)}>
          {busy ? "登録中…" : "登録する"}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setError(undefined);
          }}
        >
          キャンセル
        </button>
      </div>
    </form>
  );
}

function StaffRoleChoices(props: {
  value: StaffRole[];
  onChange: (roles: StaffRole[]) => void;
  disabled?: boolean;
  /** 変更できないロール（自分の管理者のロール） */
  locked?: StaffRole[];
}) {
  return (
    <span className="role-choices">
      {STAFF_ROLES.map((r) => (
        <label key={r} className="choice">
          <input
            type="checkbox"
            checked={props.value.includes(r)}
            disabled={props.disabled || props.locked?.includes(r)}
            onChange={(e) =>
              props.onChange(
                e.target.checked
                  ? STAFF_ROLES.filter((x) => x === r || props.value.includes(x))
                  : props.value.filter((x) => x !== r),
              )
            }
          />
          {ROLE_LABELS[r]}
        </label>
      ))}
    </span>
  );
}

type Mode =
  | { kind: "view" }
  | { kind: "roles"; roles: StaffRole[] }
  | { kind: "confirm-roles"; roles: StaffRole[] }
  | { kind: "confirm-disable" };

function UserRow(props: {
  user: AdminUser;
  onChanged: (user: AdminUser) => void;
  onNotice: (message: string) => void;
}) {
  const { user } = props;
  const api = useApi();
  const { session } = useAuth();
  const self = session?.user.sub === user.sub;
  const staff = !user.roles.includes("candidate");
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const run = async (action: () => Promise<AdminUser>, message: (u: AdminUser) => string) => {
    setBusy(true);
    setError(undefined);
    try {
      const updated = await action();
      props.onChanged(updated);
      props.onNotice(message(updated));
      setMode({ kind: "view" });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const saveRoles = (roles: StaffRole[]) =>
    run(
      () =>
        api<AdminUser>(`/admin/users/${encodeURIComponent(user.sub)}/roles`, {
          method: "PUT",
          body: JSON.stringify({ roles }),
        }),
      (u) => {
        const { adds } = rolesChange(user.roles, roles);
        return `${u.name} さんのロールを${rolesLabel(u.roles)}にしました。${
          adds.length > 0 ? "付与したロールは、次にログインしたときから有効になります。" : ""
        }`;
      },
    );

  const disable = () =>
    run(
      () =>
        api<AdminUser>(`/admin/users/${encodeURIComponent(user.sub)}/disable`, {
          method: "POST",
        }),
      (u) => `${u.name} さんを無効化しました。`,
    );

  const currentStaffRoles = user.roles.filter((r): r is StaffRole => r !== "candidate");

  return (
    <>
      <tr className={user.disabled ? "disabled-row" : undefined}>
        <td>
          {user.name}
          {self && <span className="muted">（自分）</span>}
        </td>
        <td>{user.email}</td>
        <td>{rolesLabel(user.roles)}</td>
        <td>{user.disabled ? <span className="badge badge-canceled">無効</span> : "有効"}</td>
        <td>{formatJst(user.createdAt)}</td>
        <td>
          <div className="row-actions">
            {!user.disabled && mode.kind === "view" && (
              <>
                {staff && (
                  <button
                    type="button"
                    className="link"
                    onClick={() => setMode({ kind: "roles", roles: currentStaffRoles })}
                  >
                    ロールを変更
                  </button>
                )}
                {!self && (
                  <button
                    type="button"
                    className="link danger-link"
                    onClick={() => setMode({ kind: "confirm-disable" })}
                  >
                    無効化
                  </button>
                )}
              </>
            )}
          </div>
        </td>
      </tr>
      {mode.kind !== "view" && (
        <tr className="row-panel">
          <td colSpan={6}>
            {mode.kind === "roles" && (
              <fieldset className="inline-form" aria-label={`${user.name} さんのロール`}>
                <StaffRoleChoices
                  value={mode.roles}
                  onChange={(roles) => setMode({ kind: "roles", roles })}
                  disabled={busy}
                  locked={self ? ["admin"] : undefined}
                />
                <button
                  type="button"
                  disabled={busy || mode.roles.length === 0}
                  onClick={() => {
                    const { adds, removes } = rolesChange(user.roles, mode.roles);
                    if (adds.length === 0 && removes.length === 0) setMode({ kind: "view" });
                    // 外す操作は確認する（元に戻すには付与し直す必要がある）
                    else if (removes.length > 0)
                      setMode({ kind: "confirm-roles", roles: mode.roles });
                    else void saveRoles(mode.roles);
                  }}
                >
                  {busy ? "保存中…" : "保存"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => setMode({ kind: "view" })}
                >
                  キャンセル
                </button>
                {self && <span className="muted">自分の管理者のロールは外せません。</span>}
              </fieldset>
            )}
            {mode.kind === "confirm-roles" && (
              <ConfirmDialog
                title="ロールの削除"
                confirmLabel="ロールを外す"
                busy={busy}
                onConfirm={() => void saveRoles(mode.roles)}
                onCancel={() => setMode({ kind: "view" })}
              >
                {user.name} さんから
                {rolesLabel(rolesChange(user.roles, mode.roles).removes)}
                のロールを外します。すぐに、そのロールの画面を使えなくなります。
              </ConfirmDialog>
            )}
            {mode.kind === "confirm-disable" && (
              <ConfirmDialog
                title="利用者の無効化"
                confirmLabel="無効化する"
                busy={busy}
                onConfirm={() => void disable()}
                onCancel={() => setMode({ kind: "view" })}
              >
                {user.name} さん（{user.email}）を無効化します。すぐにログインできなくなります。
                <strong>画面から有効に戻すことはできません。</strong>
                {user.roles.includes("grader") &&
                  " 採点者の場合は、割り当て済みの採点がすべて確定していることを先に確かめてください。"}
              </ConfirmDialog>
            )}
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
