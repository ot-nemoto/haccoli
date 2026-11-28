import {
  type AdminUserPage,
  AUDIT_ACTION_LABELS,
  AUDIT_ACTIONS,
  AUDIT_STATUS_LABELS,
  type AuditAction,
  type AdminAuditPage as AuditPage,
  type AuditRecord,
} from "@haccoli/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { messageOf } from "../api.js";
import { useApi } from "../auth/useApi.js";
import {
  actionLabel,
  actorLabel,
  currentMonth,
  detailEntries,
  targetLabel,
  withQuery,
} from "../lib/admin.js";
import { formatJst } from "../lib/format.js";
import { AdminLayout } from "./AdminLayout.js";

const STATUS_BADGES: Record<AuditRecord["status"], string> = {
  SUCCEEDED: "badge-graded",
  FAILED: "badge-canceled",
  STARTED: "badge-unknown",
};

/** 利用者の氏名を引くために読む最大のページ数（1 ページ 100 件） */
const NAME_PAGES = 10;

/** 監査ログ（docs/design.md §14.7 /admin/audit） */
export function AdminAuditPage() {
  const api = useApi();
  const [month, setMonth] = useState(() => currentMonth());
  const [action, setAction] = useState<AuditAction | "">("");
  const [items, setItems] = useState<AuditRecord[]>();
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [names, setNames] = useState(new Map<string, string>());
  const [namesIncomplete, setNamesIncomplete] = useState(false);
  const latest = useRef(0);

  const load = useCallback(
    async (opts: { month: string; action: AuditAction | ""; cursor?: string }) => {
      const id = ++latest.current;
      setLoading(true);
      setError(undefined);
      try {
        const page = await api<AuditPage>(withQuery("/admin/audit", { ...opts, limit: "100" }));
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
    if (month) {
      void load({ month, action });
    } else {
      // 月を消したら一覧も消す（前の月の続きを、月を付けずに読まないようにする）
      latest.current++;
      setItems(undefined);
      setCursor(undefined);
    }
  }, [load, month, action]);

  // 監査ログの対象は sub で記録している（§14.4）。表示のときだけ、利用者の一覧から氏名を補う。
  // 個人データを削除した利用者は一覧にいないので、sub のまま表示する
  useEffect(() => {
    let canceled = false;
    (async () => {
      const map = new Map<string, string>();
      let next: string | undefined;
      try {
        for (let i = 0; i < NAME_PAGES; i++) {
          const page = await api<AdminUserPage>(
            withQuery("/admin/users", { limit: "100", cursor: next }),
          );
          for (const u of page.items) map.set(u.sub, u.name);
          next = page.cursor;
          if (!next) break;
        }
      } catch {
        // 読めた分は使う。引けなかった人は sub だけになるので、そのことを表示する
        if (!canceled) setNamesIncomplete(true);
      }
      if (!canceled) setNames(map);
    })();
    return () => {
      canceled = true;
    };
  }, [api]);

  const unknown = items?.filter((r) => r.status === "STARTED").length ?? 0;

  return (
    <AdminLayout>
      <h1>監査ログ</h1>
      <p className="muted">
        管理画面と CLI の変更操作、採点結果の出力を記録しています。新しい順に表示します。
      </p>
      <div className="toolbar">
        <label className="inline">
          月
          <input type="month" value={month} required onChange={(e) => setMonth(e.target.value)} />
        </label>
        <label className="inline">
          操作
          <select value={action} onChange={(e) => setAction(e.target.value as AuditAction | "")}>
            <option value="">すべて</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {AUDIT_ACTION_LABELS[a]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {unknown > 0 && (
        <p className="notice" role="status">
          結果不明の記録が {unknown}{" "}
          件あります。記録の途中で止まった操作です。実行中でなければ、対象の状態を確かめ、必要なら同じ操作をやり直してください。
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {namesIncomplete && (
        <p className="muted">
          利用者の氏名を一部読み込めませんでした。対象が sub
          だけの行は、利用者の一覧と突き合わせてください。
        </p>
      )}
      {!month && <p>月を指定してください。</p>}
      {!items && loading && <p>読み込み中…</p>}
      {items?.length === 0 && <p>この条件の記録はありません。</p>}
      {items && items.length > 0 && (
        <table className="list audit">
          <thead>
            <tr>
              <th>日時</th>
              <th>実行者</th>
              <th>操作</th>
              <th>対象</th>
              <th>結果</th>
              <th>内容</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id}>
                <td>{formatJst(r.at)}</td>
                <td className="wrap">{actorLabel(r.actor)}</td>
                <td>{actionLabel(r.action)}</td>
                <td className="wrap">{targetLabel(r.target, names)}</td>
                <td>
                  <span className={`badge ${STATUS_BADGES[r.status]}`}>
                    {AUDIT_STATUS_LABELS[r.status]}
                  </span>
                </td>
                <td className="wrap">
                  <dl className="detail">
                    {detailEntries(r.detail).map(([k, v]) => (
                      <div key={k}>
                        <dt>{k}</dt>
                        <dd>{v}</dd>
                      </div>
                    ))}
                    {r.error && (
                      <div>
                        <dt>失敗の理由</dt>
                        <dd className="error">{r.error}</dd>
                      </div>
                    )}
                  </dl>
                </td>
              </tr>
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
            onClick={() => void load({ month, action, cursor })}
          >
            {loading ? "読み込み中…" : "さらに読み込む"}
          </button>
        </p>
      )}
    </AdminLayout>
  );
}
