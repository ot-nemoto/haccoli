import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router";
import { ApiError, apiFetch } from "../api.js";
import { useAuth } from "./AuthContext.js";
import { ROLE_ROUTES } from "./roles.js";
import { isExpired } from "./session.js";

/**
 * ログイン中の利用者として API を呼ぶ。トークン切れ（期限・401）の場合は
 * ログイン画面へ遷移し、ログイン後に元の画面へ戻れるよう遷移元を渡す。
 */
export function useApi() {
  const { session, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  return useCallback(
    async <T>(path: string, init?: RequestInit): Promise<T> => {
      const toLogin = async () => {
        const login = session ? ROLE_ROUTES[session.role].login : "/login";
        await signOut();
        navigate(login, {
          replace: true,
          state: { from: location.pathname, reason: "expired" },
        });
      };
      if (!session || isExpired(session)) {
        await toLogin();
        throw new ApiError(401, "UNAUTHORIZED", "ログインの有効期限が切れました");
      }
      try {
        return await apiFetch<T>(session.tokens.accessToken, path, init);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) await toLogin();
        throw e;
      }
    },
    [session, signOut, navigate, location.pathname],
  );
}
