import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { getMe } from "../api.js";
import type { RuntimeConfig } from "../config.js";
import { type AuthTokens, revokeToken } from "./cognito.js";
import type { ScreenRole } from "./roles.js";
import { clearSession, createSession, loadSession, type Session, saveSession } from "./session.js";

interface AuthContextValue {
  config: RuntimeConfig;
  session: Session | undefined;
  /**
   * トークン取得後に /api/me でロール・氏名を確認してセッションを開始する。
   * expectedRole と一致しない場合（候補者が採点者画面からログイン等）はトークンを失効させて
   * WrongRoleError を投げる（docs/design.md §4.1）。
   */
  signIn: (tokens: AuthTokens, expectedRole: ScreenRole) => Promise<Session>;
  signOut: () => Promise<void>;
}

export class WrongRoleError extends Error {}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider(props: { config: RuntimeConfig; children: ReactNode }) {
  const { config } = props;
  const [session, setSession] = useState<Session | undefined>(() => loadSession());

  const revoke = useCallback(
    async (refreshToken: string | undefined) => {
      // 失効に失敗してもローカルのセッションは破棄済み（トークンは最長 60 分で失効する）
      if (refreshToken) await revokeToken(config, refreshToken).catch(() => undefined);
    },
    [config],
  );

  const signIn = useCallback(
    async (tokens: AuthTokens, expectedRole: ScreenRole) => {
      let me: Awaited<ReturnType<typeof getMe>>;
      try {
        me = await getMe(tokens.accessToken);
      } catch (e) {
        await revoke(tokens.refreshToken);
        throw e;
      }
      if (!me.roles.includes(expectedRole)) {
        await revoke(tokens.refreshToken);
        throw new WrongRoleError();
      }
      const s = createSession(tokens, me, expectedRole);
      saveSession(s);
      setSession(s);
      return s;
    },
    [revoke],
  );

  const signOut = useCallback(async () => {
    const refreshToken = session?.tokens.refreshToken;
    clearSession();
    setSession(undefined);
    await revoke(refreshToken);
  }, [revoke, session]);

  const value = useMemo(
    () => ({ config, session, signIn, signOut }),
    [config, session, signIn, signOut],
  );
  return <AuthContext.Provider value={value}>{props.children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("AuthProvider の外で useAuth が呼ばれました");
  return ctx;
}
