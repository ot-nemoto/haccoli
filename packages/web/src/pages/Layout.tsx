import type { ReactNode } from "react";
import { NavLink, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthContext.js";
import { ROLE_ROUTES, type ScreenRole } from "../auth/roles.js";

export interface NavItem {
  to: string;
  label: string;
}

export function Layout(props: { userRole: ScreenRole; nav?: NavItem[]; children: ReactNode }) {
  const { session, signOut } = useAuth();
  const navigate = useNavigate();
  const routes = ROLE_ROUTES[props.userRole];
  return (
    <>
      <header className="header">
        <span className="header-title">
          {routes.label}
          {props.nav && (
            <nav className="nav" aria-label="メニュー">
              {props.nav.map((n) => (
                <NavLink key={n.to} to={n.to}>
                  {n.label}
                </NavLink>
              ))}
            </nav>
          )}
        </span>
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
      <main className={props.nav ? "content wide" : "content"}>{props.children}</main>
    </>
  );
}
