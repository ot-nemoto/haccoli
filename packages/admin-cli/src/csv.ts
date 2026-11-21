/**
 * CSV（RFC 4180）。Excel で文字化けしないよう UTF-8 BOM を付け、改行は CRLF。
 * 表計算ソフトで式として解釈される値（= + - @ タブ CR で始まる）は先頭に ' を付けて無害化する
 * （CSV インジェクション対策。候補者・採点者が入力した文字列を含むため）。
 */
export function toCsv(rows: (string | number | undefined)[][]): string {
  return `﻿${rows.map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}

function cell(value: string | number | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "number") return String(value);
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
