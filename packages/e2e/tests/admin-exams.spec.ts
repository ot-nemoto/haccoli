import { randomBytes } from "node:crypto";
import type { Context } from "@haccoli/admin-cli/context";
import { deleteE2eExam } from "@haccoli/admin-cli/testing";
import { getExamVersion, publishExam, type UserProfile } from "@haccoli/core";
import { expect, test } from "@playwright/test";
import {
  openPage,
  prepareCandidate,
  prepareStaff,
  type StaffFixture,
  setUp,
  tearDown,
  tearDownStaff,
} from "../src/fixture.js";

/**
 * 課題の作成・編集・公開（docs/design.md §14.5・§14.7）。常設の管理者 e2e-admin が、この実行用の
 * 課題（e2e-exam-…）を画面で作って公開し、その課題に受験を発行する。終了時に、課題は IAM で削除し、
 * 候補者は user:purge と同じ処理で削除する（監査ログは残る）
 */
test.describe
  .serial("管理画面の課題", () => {
    let ctx: Context;
    let f: StaffFixture;
    let candidateEmail: string;
    let candidate: UserProfile;
    const examId = `e2e-exam-${Date.now()}-${randomBytes(3).toString("hex")}`;
    const title = "E2E 画面で作った課題";

    test.beforeAll(async () => {
      ({ ctx, candidateEmail } = await setUp());
      candidate = await prepareCandidate(ctx, candidateEmail);
      f = await prepareStaff(ctx);
    });

    test.afterAll(async () => {
      if (!ctx) return;
      await Promise.allSettled([
        tearDown(ctx, candidateEmail),
        tearDownStaff(ctx),
        deleteE2eExam(ctx, examId),
      ]).then((r) => {
        const failed = r.filter((x) => x.status === "rejected");
        if (failed.length > 0) throw (failed[0] as PromiseRejectedResult).reason;
      });
    });

    test("管理者が新しい課題を作り、問題を編集して下書きを保存する", async ({
      browser,
    }, testInfo) => {
      await using s = await openPage(browser, f.webUrl, f.admin.session, "/admin/exams");
      const page = s.page;
      await page.getByRole("button", { name: "新しい課題を作る" }).click();
      const create = page.getByRole("form", { name: "新しい課題" });
      await create.getByLabel("課題 ID").fill(examId);
      await create.getByLabel("題名").fill(title);
      await create.getByRole("button", { name: "作成して編集する" }).click();
      await expect(page).toHaveURL(new RegExp(`/admin/exams/${examId}$`));

      // 最初の問題は問題文が空なので、公開の前に直すべき点が出る
      const problems = page.getByRole("region", { name: "公開の前に直すべき点" });
      await expect(problems).toContainText("問 1の本文");
      await expect(page.getByRole("button", { name: "公開する" })).toBeDisabled();

      const q1 = page.getByRole("region", { name: "問 1", exact: true });
      await q1
        .getByLabel("問題文（Markdown）")
        .fill("あなたの好きな **アルゴリズム** を説明してください。");
      // 保存できない値は、保存の前に項目を示す
      await q1.getByLabel("配点").fill("-1");
      await page.getByRole("button", { name: "下書きを保存" }).click();
      await expect(page.getByRole("region", { name: "保存できない値" })).toContainText(
        "問 1の配点: 0 以上の数を入れてください",
      );
      await q1.getByLabel("配点").fill("10");
      await expect(page.getByRole("region", { name: "保存できない値" })).toHaveCount(0);

      // 選択式の問題を足す
      await page
        .getByRole("combobox", { name: "回答形式", exact: true })
        .last()
        .selectOption("choice");
      await page.getByRole("button", { name: "問題を追加" }).click();
      const q2 = page.getByRole("region", { name: "問 2", exact: true });
      await q2.getByLabel("問題文（Markdown）").fill("HTTP で冪等なメソッドを選んでください。");
      await q2.getByLabel("複数選択できる").check();
      await q2.getByLabel("選択肢 1 の表示").fill("GET");
      await q2.getByLabel("選択肢 2 の表示").fill("POST");
      await q2.getByRole("button", { name: "選択肢を追加" }).click();
      await q2.getByLabel("選択肢 3 の表示").fill("PUT");
      await q2.getByLabel("選択肢 1 は正解").check();
      await q2.getByLabel("選択肢 3 は正解").check();
      // 正解の選択肢を消すと正解からも外れ、消えない ID が残らない（足し直して正解に戻す）
      await q2.getByRole("button", { name: "選択肢を追加" }).click();
      await q2.getByLabel("選択肢 4 の表示").fill("DELETE");
      await q2.getByLabel("選択肢 4 は正解").check();
      await q2
        .getByRole("row")
        .filter({ has: page.getByLabel("選択肢 4 の表示") })
        .getByRole("button", { name: "削除" })
        .click();
      await expect(q2.getByLabel("選択肢 4 の表示")).toHaveCount(0);
      await q2.getByLabel("配点").fill("5");
      await expect(page.getByText("保存していない変更があります")).toBeVisible();

      await page.getByRole("button", { name: "下書きを保存" }).click();
      await expect(page.getByRole("status")).toHaveText("下書きを保存しました。");
      await expect(problems).toHaveCount(0);
      await expect(page.getByRole("button", { name: "公開する" })).toBeEnabled();
      await page.screenshot({ path: testInfo.outputPath("exam-edit.png"), fullPage: true });
    });

    test("プレビューで候補者の画面と採点基準を確かめ、公開する", async ({ browser }, testInfo) => {
      await using s = await openPage(browser, f.webUrl, f.admin.session, `/admin/exams/${examId}`);
      const page = s.page;
      await page.getByRole("tab", { name: "プレビュー" }).click();
      const preview = page.getByRole("region", { name: "プレビュー" });
      await expect(preview.getByRole("heading", { name: title })).toBeVisible();
      await expect(preview.locator("strong", { hasText: "アルゴリズム" })).toBeVisible();
      // 候補者と同じ回答欄（回答はできない）
      await expect(preview.getByRole("checkbox", { name: "PUT" })).toBeDisabled();
      await expect(preview).toContainText("正解：GET・PUT");
      await expect(preview).toContainText("採点基準（10 点満点）");
      await page.screenshot({ path: testInfo.outputPath("exam-preview.png"), fullPage: true });

      await page.getByRole("button", { name: "公開する" }).click();
      const dialog = page.getByRole("dialog", { name: "課題の公開" });
      await expect(dialog).toContainText("新しい版（v1）");
      await dialog.getByRole("button", { name: "公開する" }).click();
      await expect(page.getByRole("status")).toContainText("v1 として公開しました");
      await expect(page.getByRole("table", { name: "版の履歴" })).toContainText("v1");

      // 公開した版は、公開時の検証（既定値の補完を含む）を通った定義になっている
      const v1 = await getExamVersion(ctx.deps, examId, 1);
      expect(v1?.questions.map((q) => q.qid)).toEqual(["q1", "q2"]);
      expect(v1?.questions[1]).toMatchObject({
        type: "choice",
        multiple: true,
        rubric: { correct: ["a", "c"], points: 5 },
      });

      await page.getByRole("link", { name: "課題の一覧へ" }).click();
      const row = page.getByRole("table", { name: "課題の一覧" }).getByRole("row").filter({
        hasText: examId,
      });
      await expect(row).toContainText("v1");
      await expect(row).toContainText("公開済み");
      await page.screenshot({ path: testInfo.outputPath("exams.png"), fullPage: true });
    });

    test("公開した課題に、受験を発行できる", async ({ browser }) => {
      await using s = await openPage(browser, f.webUrl, f.admin.session, "/admin/attempts");
      const page = s.page;
      await page.getByRole("button", { name: "受験を発行する" }).click();
      const form = page.getByRole("form", { name: "受験の発行" });
      await form.getByLabel("候補者のメールアドレス").fill(candidateEmail);
      await form.getByRole("combobox", { name: "課題" }).selectOption(examId);
      await form.getByRole("button", { name: "発行する" }).click();
      await expect(page.getByRole("status")).toContainText(
        `${candidate.name} さんに「${title}」を発行しました`,
      );
    });

    test("CLI で新しい版が投入された後は、古い下書きを公開できず、最新版から作り直せる", async ({
      browser,
    }) => {
      await using s = await openPage(browser, f.webUrl, f.admin.session, `/admin/exams/${examId}`);
      const page = s.page;
      await page.getByLabel("題名", { exact: true }).fill(`${title}（画面で編集）`);
      await page.getByRole("button", { name: "下書きを保存" }).click();
      await expect(page.getByRole("status")).toHaveText("下書きを保存しました。");

      // その後に、スーパー管理者が CLI（exam:publish と同じ処理）で v2 を投入する
      const v1 = await getExamVersion(ctx.deps, examId, 1);
      if (!v1) throw new Error("v1 がありません");
      await publishExam(ctx.deps, { ...v1, title: `${title}（CLI で投入）` });

      await page.reload();
      const warning = page.getByRole("alert").filter({ hasText: "このままでは公開できません" });
      await expect(warning).toContainText("v1 を元にしていますが、その後に v2 が公開されました");
      await expect(page.getByRole("button", { name: "公開する" })).toBeDisabled();
      await warning.getByRole("button", { name: "最新版から作り直す" }).click();
      const dialog = page.getByRole("dialog", { name: "最新版から作り直す" });
      await expect(dialog).toContainText("下書きで編集した内容は失われます");
      await dialog.getByRole("button", { name: "作り直す" }).click();
      await expect(warning).toHaveCount(0);
      await expect(page.getByLabel("題名", { exact: true })).toHaveValue(`${title}（CLI で投入）`);

      // 最新版と同じ内容なので、公開しても新しい版は作らない
      await page.getByRole("button", { name: "公開する" }).click();
      await page
        .getByRole("dialog", { name: "課題の公開" })
        .getByRole("button", { name: "公開する" })
        .click();
      await expect(page.getByRole("status")).toContainText("最新版（v2）と同じ内容");
    });

    test("保存していない変更があるときは、画面を離れる前に確かめる", async ({ browser }) => {
      await using s = await openPage(browser, f.webUrl, f.admin.session, `/admin/exams/${examId}`);
      const page = s.page;
      await page.getByLabel("冒頭説明（Markdown）").fill("保存しない変更");
      let asked = "";
      page.once("dialog", (d) => {
        asked = d.message();
        void d.dismiss();
      });
      await page.getByRole("link", { name: "課題", exact: true }).click();
      expect(asked).toContain("保存していない変更があります");
      await expect(page).toHaveURL(new RegExp(`/admin/exams/${examId}$`));
    });
  });
