import { examDefinitionSchema } from "@haccoli/shared/schemas";
import { describe, expect, it } from "vitest";
import {
  draftInputErrors,
  draftState,
  emptyDraft,
  move,
  newQuestion,
  nextOptionId,
  nextQid,
  previewQuestion,
  removeOption,
  renameOption,
  setMultiple,
  toggleCorrect,
  withType,
} from "./examDraft.js";

describe("課題の編集", () => {
  it("新しい課題の最初の下書きに、問題文を入れれば公開の検証を通る", () => {
    const d = emptyDraft("ex", "題名");
    expect(examDefinitionSchema.safeParse(d).success).toBe(false);
    const q = d.questions[0];
    if (q) q.body = "問題文";
    expect(examDefinitionSchema.safeParse(d).success).toBe(true);
  });

  it("qid・選択肢の id は、使われていないものを順に選ぶ", () => {
    expect(nextQid([])).toBe("q1");
    expect(nextQid(["q1", "q2"])).toBe("q3");
    // 削除で空いた番号は、既存の数より後ろから探す
    expect(nextQid(["q1", "q3"])).toBe("q4");
    expect(nextOptionId(["a", "b"])).toBe("c");
    expect(nextOptionId(["b"])).toBe("a");
  });

  it("回答形式を変えると、使わない項目を消し、使う項目を既定値で補う", () => {
    const choice = newQuestion("choice", []);
    expect(choice).toMatchObject({ multiple: false, options: [{ id: "a" }, { id: "b" }] });
    const withCorrect = {
      ...choice,
      body: "本文",
      rubric: { body: "基準", points: 5, correct: ["a"] },
    };
    const text = withType(withCorrect, "text");
    expect(text).toEqual({
      qid: "q1",
      type: "text",
      body: "本文",
      rubric: { body: "基準", points: 5 },
      maxLength: 20_000,
    });
    expect(withType(text, "file")).toMatchObject({ file: { maxSizeMB: 20 } });
    expect(withType(text, "file")).not.toHaveProperty("maxLength");
    // 選択式に戻しても、正解は消えたまま（選択肢が変わり得るため）
    expect(withType(text, "choice").rubric).toEqual({ body: "基準", points: 5 });
    // 採点基準が正解だけなら、採点基準ごと消す
    expect(withType({ ...choice, rubric: { correct: ["a"] } }, "text")).not.toHaveProperty(
      "rubric",
    );
  });

  it("並べ替えは範囲内だけ", () => {
    expect(move(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(move(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(move(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
  });

  it("プレビューは候補者に見せる形にし、採点基準を含めない", () => {
    const q = withType(
      { qid: "q1", type: "choice", body: "本文", rubric: { correct: ["a"] } },
      "choice",
    );
    expect(previewQuestion(q)).toEqual({
      qid: "q1",
      type: "choice",
      body: "本文",
      multiple: false,
      options: [
        { id: "a", label: "" },
        { id: "b", label: "" },
      ],
    });
  });

  it("下書きの状態", () => {
    const draft = {
      version: 2,
      title: "",
      baseVersion: 3,
      updatedAt: "",
      updatedBy: { sub: "", name: "" },
    };
    expect(draftState({ latestVersion: 3 })).toBe("none");
    expect(draftState({ latestVersion: 3, draft })).toBe("unpublished");
    expect(draftState({ latestVersion: 3, draft: { ...draft, publishedVersion: 3 } })).toBe(
      "published",
    );
    expect(draftState({ latestVersion: 4, draft })).toBe("stale");
    // 未公開の課題
    expect(draftState({ draft: { ...draft, baseVersion: 0 } })).toBe("unpublished");
  });
});

describe("選択肢と正解", () => {
  const choice = () => ({
    ...withType({ qid: "q1", type: "choice" as const, body: "本文" }, "choice"),
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
    ],
  });

  it("正解の選択肢を削除・ID を変更すると、正解も外す・付け替える", () => {
    const q = toggleCorrect(choice(), "c", true);
    expect(q.rubric).toEqual({ correct: ["c"] });
    expect(removeOption(q, 2)).not.toHaveProperty("rubric");
    expect(removeOption(q, 2).options?.map((o) => o.id)).toEqual(["a", "b"]);
    expect(renameOption(q, 2, "z").rubric).toEqual({ correct: ["z"] });
    // 正解でない選択肢の変更は、正解に影響しない
    expect(renameOption(q, 0, "x").rubric).toEqual({ correct: ["c"] });
    // 配点など、ほかの採点基準は残す
    expect(removeOption({ ...q, rubric: { correct: ["c"], points: 3 } }, 2).rubric).toEqual({
      points: 3,
    });
  });

  it("単一選択では正解は 1 つだけ。単一選択に戻すと、最初の正解だけ残す", () => {
    let q = toggleCorrect(choice(), "a", true);
    q = toggleCorrect(q, "b", true);
    expect(q.rubric?.correct).toEqual(["b"]);
    q = setMultiple(q, true);
    q = toggleCorrect(q, "c", true);
    expect(q.rubric?.correct).toEqual(["b", "c"]);
    expect(setMultiple(q, false).rubric?.correct).toEqual(["b"]);
    expect(toggleCorrect(q, "b", false).rubric?.correct).toEqual(["c"]);
  });
});

describe("保存の前の確認", () => {
  it("下書きとして保存できない値を、項目を示して返す", () => {
    const d = emptyDraft("ex", "題名");
    expect(draftInputErrors(d)).toEqual([]);
    const bad = {
      ...d,
      questions: [
        { qid: "q1", type: "text" as const, body: "", maxLength: 0, rubric: { points: -1 } },
        { qid: "q2", type: "file" as const, body: "", file: { maxSizeMB: 25 } },
        {
          qid: "q3",
          type: "choice" as const,
          body: "",
          options: Array.from({ length: 51 }, (_, i) => ({ id: `o${i}`, label: "" })),
        },
      ],
    };
    expect(draftInputErrors(bad)).toEqual([
      "問 1の配点: 0 以上の数を入れてください",
      "問 1の最大文字数: 1〜100,000 の整数を入れてください",
      "問 2の最大サイズ: 20 MB 以下の正の数を入れてください",
      "問 3の選択肢: 50 個までにしてください",
    ]);
  });
});
