import type { AuthTokens } from "./cognito.js";

export interface SessionUser {
  sub: string;
  email: string;
  name: string;
  groups: string[];
}

export interface Session {
  tokens: AuthTokens;
  user: SessionUser;
  /** エポックミリ秒 */
  expiresAt: number;
}

// ブラウザ（タブ）を閉じたら消える sessionStorage を使う。
// 再訪時は必ず OTP による再ログインとなる（要件）。localStorage は使わない。
const STORAGE_KEY = "haccoli.session";

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) throw new Error("JWT の形式が不正です");
  const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

/** ID トークンからセッションを組み立てる（署名検証はサーバー側の責務。ここでは表示・画面遷移用） */
export function createSession(tokens: AuthTokens, now: number = Date.now()): Session {
  const claims = decodeJwtPayload(tokens.idToken);
  const groups = claims["cognito:groups"];
  return {
    tokens,
    user: {
      sub: String(claims.sub),
      email: String(claims.email ?? ""),
      name: String(claims.name ?? ""),
      groups: Array.isArray(groups) ? groups.map(String) : [],
    },
    expiresAt: now + tokens.expiresIn * 1000,
  };
}

export function isExpired(session: Session, now: number = Date.now()): boolean {
  // 期限直前のリクエスト失敗を避けるため 1 分の余裕を持たせる
  return now >= session.expiresAt - 60_000;
}

export function saveSession(session: Session): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function loadSession(): Session | undefined {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const session = JSON.parse(raw) as Session;
    return isExpired(session) ? undefined : session;
  } catch {
    return undefined;
  }
}

export function clearSession(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}
