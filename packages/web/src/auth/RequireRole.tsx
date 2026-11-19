import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { useAuth } from "./AuthContext.js";
import { ROLE_ROUTES, type Role } from "./roles.js";
import { isExpired } from "./session.js";

/** ロールに応じた画面ガード。未ログイン・期限切れ・ロール不一致はログイン画面へ戻す */
export function RequireRole(props: { userRole: Role; children: ReactNode }) {
  const { session } = useAuth();
  const routes = ROLE_ROUTES[props.userRole];
  if (!session || isExpired(session) || !session.user.groups.includes(props.userRole)) {
    return <Navigate to={routes.login} replace />;
  }
  return <>{props.children}</>;
}
