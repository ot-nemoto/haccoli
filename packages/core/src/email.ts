import { ValidationError } from "./errors.js";

// 実用上十分な簡易チェック（厳密な RFC 準拠は目指さない）
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 前後空白を除去し小文字化する。Cognito のユーザー名・DynamoDB の検索キーに使う。 */
export function normalizeEmail(input: string): string {
  const email = input.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    throw new ValidationError(`メールアドレスの形式が不正です: ${input}`);
  }
  return email;
}
