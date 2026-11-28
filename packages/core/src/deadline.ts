import { ValidationError } from "./errors.js";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** JST の日付（YYYY-MM-DD） */
export function jstDate(now: Date): string {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 期限日（YYYY-MM-DD）→ その日の 23:59:59.999 JST を UTC の ISO 8601 で返す（docs/design.md §6.4）。
 * 比較は ISO 文字列の辞書順で行うため、必ず toISOString と同じ形式にする。
 */
export function deadlineAtFromDate(date: string): string {
  const m = DATE_PATTERN.exec(date);
  if (!m) throw new ValidationError(`期限日は YYYY-MM-DD 形式で指定してください: ${date}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utcMidnight = Date.UTC(y, mo - 1, d);
  const check = new Date(utcMidnight);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw new ValidationError(`存在しない日付です: ${date}`);
  }
  // JST 翌日 0:00 の 1ms 前
  return new Date(utcMidnight + 24 * 60 * 60 * 1000 - JST_OFFSET_MS - 1).toISOString();
}

/**
 * 発行・延長時の期限日チェック。過去日はエラー、当日は force 指定時のみ許可。
 */
export function validateDeadlineDate(date: string, now: Date, force = false): string {
  const deadlineAt = deadlineAtFromDate(date);
  const today = jstDate(now);
  if (date < today) throw new ValidationError(`過去の日付は指定できません: ${date}`);
  if (date === today && !force) {
    throw new ValidationError(
      `当日は期限にできません。翌日以降を指定してください（CLI では --force で当日にできます）: ${date}`,
    );
  }
  return deadlineAt;
}
