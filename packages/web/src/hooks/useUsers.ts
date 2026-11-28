import type { AdminUser, AdminUserPage, Role } from "@haccoli/shared";
import { useEffect, useState } from "react";
import { useApi } from "../auth/useApi.js";
import { withQuery } from "../lib/admin.js";

/** 読む最大のページ数（1 ページ 100 件） */
const MAX_PAGES = 10;

/**
 * 管理画面で、利用者を一覧から引く（監査ログの氏名、受験の発行の候補者、割り当ての採点者）。
 * 最大 MAX_PAGES ページまで読む。途中で失敗したら、読めた分を返し incomplete にする
 */
export function useUsers(role?: Role): { users?: AdminUser[]; incomplete: boolean } {
  const api = useApi();
  const [users, setUsers] = useState<AdminUser[]>();
  const [incomplete, setIncomplete] = useState(false);

  useEffect(() => {
    let canceled = false;
    (async () => {
      const found: AdminUser[] = [];
      let next: string | undefined;
      let partial = false;
      try {
        for (let i = 0; i < MAX_PAGES; i++) {
          const page = await api<AdminUserPage>(
            withQuery("/admin/users", { role, limit: "100", cursor: next }),
          );
          found.push(...page.items);
          next = page.cursor;
          if (!next) break;
        }
        // 上限まで読んでも続きがある
        if (next) partial = true;
      } catch {
        partial = true;
      }
      if (canceled) return;
      setUsers(found);
      setIncomplete(partial);
    })();
    return () => {
      canceled = true;
    };
  }, [api, role]);

  return { users, incomplete };
}
