import type { MeResponse } from "@haccoli/shared";
import type { AuthTokens } from "./cognito.js";
import type { ScreenRole } from "./roles.js";

/** ログイン中の利用者。ロール・氏名は /api/me（サーバー側の登録情報）を正とする */
export type SessionUser = MeResponse;

export interface Session {
  tokens: AuthTokens;
  user: SessionUser;
  /** ログインした画面のロール（採点者と管理者を兼ねる人は、画面ごとにログインする。§14.2） */
  role: ScreenRole;
  /** エポックミリ秒 */
  expiresAt: number;
}

// ブラウザ（タブ）を閉じたら消える sessionStorage を使う。
// 再訪時は必ず OTP による再ログインとなる（要件）。localStorage は使わない。
const STORAGE_KEY = "haccoli.session";

export function createSession(
  tokens: AuthTokens,
  user: SessionUser,
  role: ScreenRole,
  now: number = Date.now(),
): Session {
  return {
    tokens,
    user: { sub: user.sub, name: user.name, roles: [...user.roles] },
    role,
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
    // 旧形式（ロールが 1 つの形式など）のセッションは破棄して再ログインさせる
    if (!session.role || !Array.isArray(session.user?.roles)) return undefined;
    if (!session.user.roles.includes(session.role)) return undefined;
    return isExpired(session) ? undefined : session;
  } catch {
    return undefined;
  }
}

export function clearSession(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}
