import { describe, expect, it } from "vitest";
import { toCsv } from "./csv.js";

describe("toCsv", () => {
  it("BOM・CRLF を付け、カンマ・引用符・改行を含む値を引用する", () => {
    expect(toCsv([["a", 'b"c', "d,e", "f\ng", 1, undefined]])).toBe('﻿a,"b""c","d,e","f\ng",1,\r\n');
  });

  it.each([
    ["=HYPERLINK(1)", "'=HYPERLINK(1)"],
    ["+1", "'+1"],
    ["-1+1", "'-1+1"],
    ["@SUM(A1)", "'@SUM(A1)"],
  ])("式として解釈される %s を無害化する", (input, expected) => {
    expect(toCsv([[input]])).toBe(`﻿${expected}\r\n`);
  });

  it("数値の負数は数値のまま出力する", () => {
    expect(toCsv([[-1]])).toBe("﻿-1\r\n");
  });
});
