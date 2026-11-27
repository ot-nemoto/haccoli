import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { useAuth } from "./AuthContext.js";
import { ROLE_ROUTES, type ScreenRole } from "./roles.js";
import { isExpired } from "./session.js";

/** ロールに応じた画面ガード。未ログイン・期限切れ・ロール不一致はログイン画面へ戻す */
export function RequireRole(props: { userRole: ScreenRole; children: ReactNode }) {
  const { session } = useAuth();
  const location = useLocation();
  const routes = ROLE_ROUTES[props.userRole];
  if (!session || isExpired(session) || session.role !== props.userRole) {
    // ログイン後に元の画面へ戻れるよう遷移元を渡す
    return <Navigate to={routes.login} replace state={{ from: location.pathname }} />;
  }
  return <>{props.children}</>;
}
