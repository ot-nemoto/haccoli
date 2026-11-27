import { ValidationError } from "./errors.js";

/**
 * 一覧のページング（docs/design.md §14.3・§14.6）。管理者 API の一覧で使う。
 *
 * Scan・Query にフィルタを付けると、DynamoDB の 1 回の応答が空のことがある。
 * 指定件数に達するか最後まで読み進めてから返し、空のページを返さない。
 * 次のページがあるのは、指定件数より 1 件多く見つかったときだけにする（最後のページの次が空にならない）。
 */

export interface Page<T> {
  items: T[];
  /** 次のページの開始位置。最後のページでは無い */
  cursor?: string;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

type Key = { PK: string; SK: string };

/** DynamoDB の 1 回の読み込み（Scan・Query）。startKey から読む */
export type PageFetch = (startKey: Key | undefined) => Promise<{
  Items?: Record<string, unknown>[];
  LastEvaluatedKey?: Record<string, unknown>;
}>;

/**
 * カーソルは、そのページの最後のアイテムのキー（PK・SK）。
 * テーブル本体の Scan・Query は、どのアイテムのキーからでも続きを読める。
 *
 * @param isValidKey 改ざんされたカーソルで、別の種類のアイテムから読み始めないための確認
 */
export async function readPage(
  fetch: PageFetch,
  opts: { limit?: number; cursor?: string; isValidKey: (key: Key) => boolean },
): Promise<Page<Record<string, unknown>>> {
  const limit = pageSize(opts.limit);
  let startKey = opts.cursor ? decodeCursor(opts.cursor, opts.isValidKey) : undefined;
  const items: Record<string, unknown>[] = [];
  do {
    const res = await fetch(startKey);
    items.push(...(res.Items ?? []));
    if (items.length > limit) {
      const page = items.slice(0, limit);
      return { items: page, cursor: encodeCursor(keyOf(page[page.length - 1])) };
    }
    startKey = res.LastEvaluatedKey as Key | undefined;
  } while (startKey);
  return { items };
}

function pageSize(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new ValidationError(`件数は 1〜${MAX_PAGE_SIZE} で指定してください`);
  }
  return limit;
}

function keyOf(item: Record<string, unknown> | undefined): Key {
  return { PK: String(item?.PK), SK: String(item?.SK) };
}

function encodeCursor(key: Key): string {
  return Buffer.from(JSON.stringify(key)).toString("base64url");
}

function decodeCursor(cursor: string, isValidKey: (key: Key) => boolean): Key {
  const invalid = () => new ValidationError("ページの指定が不正です");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Object.keys(parsed).length !== 2 ||
    typeof (parsed as Key).PK !== "string" ||
    typeof (parsed as Key).SK !== "string"
  ) {
    throw invalid();
  }
  const key = { PK: (parsed as Key).PK, SK: (parsed as Key).SK };
  if (!isValidKey(key)) throw invalid();
  return key;
}
