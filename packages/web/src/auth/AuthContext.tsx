import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import type { RuntimeConfig } from "../config.js";
import { type AuthTokens, revokeToken } from "./cognito.js";
import { clearSession, createSession, loadSession, type Session, saveSession } from "./session.js";

interface AuthContextValue {
  config: RuntimeConfig;
  session: Session | undefined;
  signIn: (tokens: AuthTokens) => Session;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider(props: { config: RuntimeConfig; children: ReactNode }) {
  const { config } = props;
  const [session, setSession] = useState<Session | undefined>(() => loadSession());

  const signIn = useCallback((tokens: AuthTokens) => {
    const s = createSession(tokens);
    saveSession(s);
    setSession(s);
    return s;
  }, []);

  const signOut = useCallback(async () => {
    // signIn 直後に呼ばれる場合（ロール不一致）に備え、state ではなく保存済みセッションを優先する
    const refreshToken = (loadSession() ?? session)?.tokens.refreshToken;
    clearSession();
    setSession(undefined);
    // 失効に失敗してもローカルのセッションは破棄済み（トークンは最長 60 分で失効する）
    if (refreshToken) await revokeToken(config, refreshToken).catch(() => undefined);
  }, [config, session]);

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
