import type { ReactNode } from "react";
import { Layout, type NavItem } from "./Layout.js";

/** 管理画面のメニュー（docs/design.md §14.7） */
const ADMIN_NAV: NavItem[] = [
  // /admin は他の画面の親のパスでもあるため、完全一致のときだけ選択中にする
  { to: "/admin", label: "ダッシュボード", end: true },
  { to: "/admin/attempts", label: "受験" },
  { to: "/admin/results", label: "採点結果" },
  { to: "/admin/exams", label: "課題" },
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
