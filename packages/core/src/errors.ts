/** ドメインエラー。API ではステータスコードへ、CLI ではメッセージへ変換する */
export class DomainError extends Error {}

/** 対象が存在しない、または利用者のものではない（存在を区別しない） */
export class NotFoundError extends DomainError {}

/** 入力が不正 */
export class ValidationError extends DomainError {}

/** 状態が操作を許さない（提出済み・期限切れ・未開始など） */
export class StateError extends DomainError {
  constructor(
    readonly reason: "NOT_STARTED" | "ALREADY_SUBMITTED" | "EXPIRED" | "CANCELED" | "INVALID",
    message: string,
  ) {
    super(message);
  }
}

/** 楽観ロックの競合（別の画面で更新された） */
export class VersionConflictError extends DomainError {
  constructor() {
    super("他の画面で更新されています。再読み込みしてください");
  }
}
