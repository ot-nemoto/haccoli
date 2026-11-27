import { type FormEvent, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { ApiError } from "../api.js";
import { useAuth, WrongRoleError } from "../auth/AuthContext.js";
import { describeError, startEmailOtp, verifyEmailOtp } from "../auth/cognito.js";
import { ROLE_ROUTES, type ScreenRole, safeReturnPath } from "../auth/roles.js";

type Step = { kind: "email" } | { kind: "code"; email: string; session: string };

export function LoginPage(props: { userRole: ScreenRole }) {
  const { config, session, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as { from?: unknown; reason?: string } | null;
  const returnTo = safeReturnPath(props.userRole, state?.from);
  const routes = ROLE_ROUTES[props.userRole];

  const [step, setStep] = useState<Step>({ kind: "email" });
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (session?.role === props.userRole) {
    return <Navigate to={returnTo} replace />;
  }

  const onSubmitEmail = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      const normalized = email.trim().toLowerCase();
      const result = await startEmailOtp(config, normalized);
      if (result.kind === "tokens") {
        await complete(result.tokens);
      } else {
        setStep({ kind: "code", email: normalized, session: result.session });
        setCode("");
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const onSubmitCode = async (e: FormEvent) => {
    e.preventDefault();
    if (step.kind !== "code") return;
    setError(undefined);
    setBusy(true);
    try {
      const tokens = await verifyEmailOtp(config, {
        email: step.email,
        session: step.session,
        code: code.trim(),
      });
      await complete(tokens);
    } catch (err) {
      setError(describeError(err));
      const code = (err as { code?: string }).code;
      if (code === "NotAuthorizedException" || code === "ExpiredCodeException") {
        setStep({ kind: "email" });
      }
    } finally {
      setBusy(false);
    }
  };

  const complete = async (tokens: Parameters<typeof signIn>[0]) => {
    try {
      await signIn(tokens, props.userRole);
    } catch (err) {
      setStep({ kind: "email" });
      if (err instanceof WrongRoleError || (err instanceof ApiError && err.status === 403)) {
        // 候補者が採点者画面から（またはその逆）ログインした場合、無効化済みの場合は拒否する
        setError("このアカウントではこの画面にログインできません。");
        return;
      }
      throw err;
    }
    navigate(returnTo, { replace: true });
  };

  return (
    <main className="card">
      <h1>{routes.label} ログイン</h1>
      {state?.reason === "expired" && (
        <p className="notice">
          ログインの有効期限が切れました。再度ログインしてください。入力途中の回答はこのタブに一時保存されています。
        </p>
      )}
      {step.kind === "email" ? (
        <form onSubmit={onSubmitEmail}>
          <p>登録されたメールアドレスを入力してください。パスコードをメールでお送りします。</p>
          <label>
            メールアドレス
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
            />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? "送信中…" : "パスコードを送信"}
          </button>
        </form>
      ) : (
        <form onSubmit={onSubmitCode}>
          <p>
            {step.email}{" "}
            が登録済みの場合、パスコードを送信しました。メールに記載されたパスコードを入力してください。
          </p>
          <label>
            パスコード
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6,8}"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={busy}
            />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? "確認中…" : "ログイン"}
          </button>
          <button
            type="button"
            className="link"
            disabled={busy}
            onClick={() => {
              setStep({ kind: "email" });
              setError(undefined);
            }}
          >
            メールアドレスを入力し直す
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </main>
  );
}
