import type { AnswerContent } from "@haccoli/shared";

/**
 * 未保存の入力を sessionStorage に退避する（docs/design.md §7.2）。
 * トークン切れで再ログインしても同じタブなら復元できる。タブを閉じれば消える。
 */
const key = (attemptId: string, qid: string) => `haccoli.draft.${attemptId}.${qid}`;

export interface Draft {
  content: AnswerContent;
  /** 退避時点で読み込んでいた版。サーバーの版と異なれば復元しない */
  baseVersion: number;
}

export function saveDraft(attemptId: string, qid: string, draft: Draft): void {
  try {
    sessionStorage.setItem(key(attemptId, qid), JSON.stringify(draft));
  } catch {
    // 容量超過・プライベートモード等では退避しない（自動保存は継続する）
  }
}

export function loadDraft(attemptId: string, qid: string): Draft | undefined {
  try {
    const raw = sessionStorage.getItem(key(attemptId, qid));
    return raw ? (JSON.parse(raw) as Draft) : undefined;
  } catch {
    return undefined;
  }
}

export function clearDraft(attemptId: string, qid: string): void {
  try {
    sessionStorage.removeItem(key(attemptId, qid));
  } catch {
    // 何もしない
  }
}
