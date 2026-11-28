import type { ReactNode } from "react";
import { Layout, type NavItem } from "./Layout.js";

/** 管理画面のメニュー。受験・採点結果は Step 8-2・8-3 で追加する（docs/design.md §14.7） */
const ADMIN_NAV: NavItem[] = [
  { to: "/admin/users", label: "利用者" },
  { to: "/admin/audit", label: "監査ログ" },
];

export function AdminLayout(props: { children: ReactNode }) {
  return (
    <Layout userRole="admin" nav={ADMIN_NAV}>
      {props.children}
    </Layout>
  );
}
