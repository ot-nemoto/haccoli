import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../auth/AuthContext.js";
import { ROLE_ROUTES, type ScreenRole } from "../auth/roles.js";

export function Layout(props: { userRole: ScreenRole; children: ReactNode }) {
  const { session, signOut } = useAuth();
  const navigate = useNavigate();
  const routes = ROLE_ROUTES[props.userRole];
  return (
    <>
      <header className="header">
        <span>{routes.label}</span>
        <span>
          {session?.user.name} さん{" "}
          <button
            type="button"
            className="link"
            onClick={async () => {
              await signOut();
              navigate(routes.login, { replace: true });
            }}
          >
            ログアウト
          </button>
        </span>
      </header>
      <main className="content">{props.children}</main>
    </>
  );
}
