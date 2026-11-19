import type { RuntimeConfig } from "../config.js";

/**
 * Cognito User Pools API の最小クライアント。
 * 未認証で呼べる操作（InitiateAuth / RespondToAuthChallenge / RevokeToken）のみを使うため
 * SigV4 署名は不要。SDK や Amplify を入れずにバンドルを小さく保つ。
 */
export class CognitoError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface AuthTokens {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
}

export type StartResult =
  | { kind: "otp"; session: string; destination?: string }
  | { kind: "tokens"; tokens: AuthTokens };

interface ChallengeResponse {
  ChallengeName?: string;
  Session?: string;
  ChallengeParameters?: Record<string, string>;
  AuthenticationResult?: {
    IdToken: string;
    AccessToken: string;
    RefreshToken?: string;
    ExpiresIn: number;
  };
}

async function call<T>(config: RuntimeConfig, action: string, body: object): Promise<T> {
  const res = await fetch(`https://cognito-idp.${config.region}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSCognitoIdentityProviderService.${action}`,
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const type = String(json.__type ?? "UnknownError");
    throw new CognitoError(type.split("#").pop() ?? type, String(json.message ?? res.statusText));
  }
  return json as T;
}

function toResult(res: ChallengeResponse): StartResult | ChallengeResponse {
  if (res.AuthenticationResult) {
    const r = res.AuthenticationResult;
    return {
      kind: "tokens",
      tokens: {
        idToken: r.IdToken,
        accessToken: r.AccessToken,
        refreshToken: r.RefreshToken,
        expiresIn: r.ExpiresIn,
      },
    };
  }
  if (res.ChallengeName === "EMAIL_OTP" && res.Session) {
    return {
      kind: "otp",
      session: res.Session,
      destination: res.ChallengeParameters?.CODE_DELIVERY_DESTINATION,
    };
  }
  return res;
}

/** メールアドレスで認証を開始し、Email OTP を送信させる */
export async function startEmailOtp(config: RuntimeConfig, email: string): Promise<StartResult> {
  const first = await call<ChallengeResponse>(config, "InitiateAuth", {
    AuthFlow: "USER_AUTH",
    ClientId: config.userPoolClientId,
    AuthParameters: { USERNAME: email, PREFERRED_CHALLENGE: "EMAIL_OTP" },
  });
  let result = toResult(first);

  // 優先チャレンジが受け付けられず選択を求められた場合は EMAIL_OTP を明示的に選ぶ
  if (!("kind" in result) && result.ChallengeName === "SELECT_CHALLENGE") {
    const selected = await call<ChallengeResponse>(config, "RespondToAuthChallenge", {
      ChallengeName: "SELECT_CHALLENGE",
      ClientId: config.userPoolClientId,
      Session: result.Session,
      ChallengeResponses: { USERNAME: email, ANSWER: "EMAIL_OTP" },
    });
    result = toResult(selected);
  }

  if (!("kind" in result)) {
    throw new CognitoError(
      "UnexpectedChallenge",
      `想定外の認証チャレンジです: ${result.ChallengeName ?? "(なし)"}`,
    );
  }
  return result;
}

/** メールで届いたパスコードを送信してトークンを得る */
export async function verifyEmailOtp(
  config: RuntimeConfig,
  params: { email: string; session: string; code: string },
): Promise<AuthTokens> {
  const res = await call<ChallengeResponse>(config, "RespondToAuthChallenge", {
    ChallengeName: "EMAIL_OTP",
    ClientId: config.userPoolClientId,
    Session: params.session,
    ChallengeResponses: { USERNAME: params.email, EMAIL_OTP_CODE: params.code },
  });
  const result = toResult(res);
  if ("kind" in result && result.kind === "tokens") return result.tokens;
  throw new CognitoError("UnexpectedChallenge", "認証を完了できませんでした");
}

/** リフレッシュトークンを失効させる（関連するアクセストークンも無効になる） */
export async function revokeToken(config: RuntimeConfig, refreshToken: string): Promise<void> {
  await call(config, "RevokeToken", { ClientId: config.userPoolClientId, Token: refreshToken });
}

/** 利用者に見せるエラーメッセージ */
export function describeError(e: unknown): string {
  if (e instanceof CognitoError) {
    switch (e.code) {
      case "CodeMismatchException":
        return "パスコードが正しくありません。";
      case "ExpiredCodeException":
        return "パスコードの有効期限が切れました。最初からやり直してください。";
      case "NotAuthorizedException":
        return "認証の有効期限が切れたか、ログインできないアカウントです。最初からやり直してください。";
      case "LimitExceededException":
      case "TooManyRequestsException":
      case "TooManyFailedAttemptsException":
        return "試行回数が上限に達しました。しばらく時間をおいてからお試しください。";
    }
  }
  return "エラーが発生しました。時間をおいて再度お試しください。";
}
