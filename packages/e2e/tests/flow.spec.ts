import type { Context } from "@haccoli/admin-cli/context";
import { type Browser, expect, type Page, test } from "@playwright/test";
import {
  type Actor,
  assignGrader,
  attemptStatus,
  type Fixture,
  prepare,
  SESSION_KEY,
  setUp,
  tearDown,
  tinyZip,
} from "../src/fixture.js";

/**
 * 受験の発行 → 候補者の回答・提出 → 採点者の割り当て → 採点・確定 までの一連の流れ。
 * ログイン画面（OTP の入力）は対象外。
 */
test.describe
  .serial("受験から採点の確定まで", () => {
    let ctx: Context;
    let candidateEmail: string;
    let f: Fixture;

    test.beforeAll(async () => {
      ({ ctx, candidateEmail } = await setUp());
      f = await prepare(ctx, candidateEmail);
    });

    test.afterAll(async () => {
      if (ctx) await tearDown(ctx, candidateEmail);
    });

    test("候補者が回答して提出する", async ({ browser }) => {
      const page = await open(browser, f, f.candidate, "/exam");
      // 課題が 1 件だけなら、課題の画面に自動で移る
      await expect(page).toHaveURL(new RegExp(`/exam/${f.attemptId}$`));
      await page.getByRole("button", { name: "開始する" }).click();

      await page.getByRole("textbox", { name: "問 1 の回答" }).fill("E2E テストの回答です。");
      await page.getByRole("radio", { name: "PUT" }).check();
      await page.getByRole("checkbox", { name: "SQL をプレースホルダで組み立てる" }).check();
      await page.getByRole("checkbox", { name: "出力時に HTML エスケープする" }).check();
      await page.locator("#q-q4 input[type=file]").setInputFiles({
        name: "answer.zip",
        mimeType: "application/zip",
        buffer: tinyZip("README.md", "# E2E\n"),
      });
      await expect(page.locator("#q-q4")).toContainText("answer.zip");

      await page.getByRole("button", { name: "すべて保存" }).click();
      // 保存の通信中に提出すると未保存と判定される不具合（#19）を避けるため、保存の完了を待つ。
      // #19 の修正後にこの待ち合わせを外す
      await expect(page.getByRole("button", { name: "すべて保存" })).toBeDisabled();
      await expect(page.getByText(/保存中…|未保存/)).toHaveCount(0);
      await page.getByRole("button", { name: "提出する" }).click();
      await page
        .getByRole("dialog", { name: "提出の確認" })
        .getByRole("button", { name: "提出する" })
        .click();

      await expect(page.getByRole("heading", { name: "提出が完了しました" })).toBeVisible();
      expect(await attemptStatus(f)).toBe("SUBMITTED");
    });

    test("採点者が採点して確定する", async ({ browser }) => {
      await assignGrader(f);
      const page = await open(browser, f, f.grader, "/grader");
      await page.getByRole("link", { name: f.candidate.user.name }).click();
      await expect(page).toHaveURL(new RegExp(`/grader/${f.attemptId}$`));
      // 提出した回答が表示される
      await expect(page.getByText("E2E テストの回答です。")).toBeVisible();

      const scores = page.getByRole("spinbutton");
      await expect(scores).toHaveCount(4);
      for (const [i, score] of [40, 20, 30, 0].entries()) await scores.nth(i).fill(String(score));
      await page.getByRole("textbox", { name: "総評" }).fill("E2E テストの総評です。");

      await page.getByRole("button", { name: "採点を確定する" }).click();
      await page
        .getByRole("dialog", { name: "採点の確定" })
        .getByRole("button", { name: "確定する" })
        .click();

      await expect(page.getByText("採点を確定しました。")).toBeVisible();
      expect(await attemptStatus(f)).toBe("GRADED");
    });
  });

/** トークンを sessionStorage に入れた状態で画面を開く（OTP のログインを経ない） */
async function open(browser: Browser, f: Fixture, actor: Actor, path: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: f.webUrl });
  await context.addInitScript(
    ([key, value]) => {
      if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, value);
    },
    [SESSION_KEY, actor.session] as const,
  );
  const page = await context.newPage();
  await page.goto(path);
  return page;
}
