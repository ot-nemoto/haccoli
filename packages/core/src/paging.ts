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

// ---- 複数の読み込み元を続けて読むページング ----

/** 索引（GSI）のキーを含む、続きを読むためのキー */
export type AnyKey = Record<string, string>;

/**
 * 一覧の読み込み元の 1 つ（例: GSI2 の 1 つの状態）。順に読み、続けて 1 つの一覧にする。
 */
export interface PageSource {
  fetch: (startKey: AnyKey | undefined) => Promise<{
    Items?: Record<string, unknown>[];
    LastEvaluatedKey?: Record<string, unknown>;
  }>;
  /** アイテムから、続きを読むためのキー（索引のキーを含む）を取り出す */
  keyOf: (item: Record<string, unknown>) => AnyKey;
  /** 改ざんされたカーソルで、別の種類のアイテムや別の読み込み元から読み始めないための確認 */
  isValidKey: (key: AnyKey) => boolean;
}

/**
 * 複数の読み込み元のカーソル。i は読み込み元の番号、k はそのページの最後のアイテムのキー。
 * t は 1 ページ目を読んだときの基準（例: 時刻）。ページをまたいで読み込み元の区切りを変えないために使う
 */
export interface SourcesCursor {
  i: number;
  k: AnyKey;
  t: string;
}

const MAX_KEY_FIELDS = 4;

/** カーソルの形だけを確かめる。読み込み元とキーの確認は readSourcesPage で行う */
export function decodeSourcesCursor(cursor: string): SourcesCursor {
  const invalid = () => new ValidationError("ページの指定が不正です");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (typeof parsed !== "object" || parsed === null) throw invalid();
  const { i, k, t, ...rest } = parsed as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || !Number.isInteger(i) || (i as number) < 0) throw invalid();
  if (typeof t !== "string" || t.length === 0 || t.length > 64) throw invalid();
  if (typeof k !== "object" || k === null || Array.isArray(k)) throw invalid();
  const entries = Object.entries(k);
  if (
    entries.length === 0 ||
    entries.length > MAX_KEY_FIELDS ||
    entries.some(([, v]) => typeof v !== "string")
  ) {
    throw invalid();
  }
  return { i: i as number, k: k as AnyKey, t };
}

/**
 * 読み込み元を順に読み、指定件数のページを返す（readPage と同じく、空のページを返さず、
 * 次のページは指定件数より多く見つかったときだけ返す）。
 *
 * @param opts.token カーソルに入れる基準（SourcesCursor の t）
 */
export async function readSourcesPage(
  sources: PageSource[],
  opts: { limit?: number; cursor?: SourcesCursor; token: string },
): Promise<Page<Record<string, unknown>>> {
  const limit = pageSize(opts.limit);
  const start = opts.cursor;
  if (start && (start.i >= sources.length || !sources[start.i]?.isValidKey(start.k))) {
    throw new ValidationError("ページの指定が不正です");
  }
  const found: { item: Record<string, unknown>; i: number }[] = [];
  for (let i = start?.i ?? 0; i < sources.length; i++) {
    const source = sources[i] as PageSource;
    let startKey: AnyKey | undefined = i === start?.i ? start.k : undefined;
    do {
      const res = await source.fetch(startKey);
      for (const item of res.Items ?? []) found.push({ item, i });
      if (found.length > limit) {
        const last = found[limit - 1] as { item: Record<string, unknown>; i: number };
        const cursor: SourcesCursor = {
          i: last.i,
          k: (sources[last.i] as PageSource).keyOf(last.item),
          t: opts.token,
        };
        return {
          items: found.slice(0, limit).map((f) => f.item),
          cursor: Buffer.from(JSON.stringify(cursor)).toString("base64url"),
        };
      }
      startKey = res.LastEvaluatedKey as AnyKey | undefined;
    } while (startKey);
  }
  return { items: found.map((f) => f.item) };
}
