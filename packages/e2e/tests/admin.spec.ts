import type { Context } from "@haccoli/admin-cli/context";
import { expect, test } from "@playwright/test";
import {
  openPage,
  prepareStaff,
  type StaffFixture,
  setUp,
  tearDown,
  tearDownStaff,
} from "../src/fixture.js";

/**
 * 管理画面（docs/design.md §14.7）。常設の管理者 e2e-admin で、利用者の一覧・ロールの変更・
 * 監査ログを確かめる。ロールの変更の対象は常設の採点者 e2e-grader（終了時に grader だけに戻す）。
 */
test.describe
  .serial("管理画面", () => {
    let ctx: Context;
    let f: StaffFixture;
    /** 画面から登録する候補者（終了時に user:purge と同じ処理で削除する） */
    let candidateEmail: string;

    test.beforeAll(async () => {
      ({ ctx, candidateEmail } = await setUp());
      f = await prepareStaff(ctx);
    });

    test.afterAll(async () => {
      if (!ctx) return;
      await Promise.allSettled([tearDown(ctx, candidateEmail), tearDownStaff(ctx)]).then((r) => {
        const failed = r.filter((x) => x.status === "rejected");
        if (failed.length > 0) throw (failed[0] as PromiseRejectedResult).reason;
      });
    });

    test("管理者でない人は管理画面に入れない", async ({ browser }) => {
      // 採点者の画面のセッションでは、管理画面のログインに戻される
      {
        await using s = await openPage(browser, f.webUrl, f.grader.session, "/admin/users");
        await expect(s.page).toHaveURL(/\/admin\/login$/);
        await expect(s.page.getByRole("heading", { name: "管理 ログイン" })).toBeVisible();
      }
      // 画面のロールを書き換えても、API が拒否する（トークンのグループと登録情報で判定する）
      const forged = JSON.parse(f.grader.session);
      forged.role = "admin";
      forged.user.roles = ["grader", "admin"];
      {
        await using s = await openPage(browser, f.webUrl, JSON.stringify(forged), "/admin/users");
        await expect(s.page.getByRole("alert")).toHaveText("この操作は許可されていません");
        await expect(s.page.getByRole("table")).toHaveCount(0);
      }
    });

    test("管理者が採点者に管理者のロールを付与し、外す", async ({ browser }, testInfo) => {
      await using s = await openPage(browser, f.webUrl, f.admin.session, "/admin");
      const page = s.page;
      await expect(page).toHaveURL(/\/admin\/users$/);
      await expect(page.getByRole("heading", { name: "利用者", exact: true })).toBeVisible();

      await page.getByRole("combobox", { name: "ロール", exact: true }).selectOption("grader");
      const row = page.getByRole("row").filter({ hasText: f.grader.user.email });
      await expect(row).toContainText("採点者");
      await page.screenshot({ path: testInfo.outputPath("admin-users.png"), fullPage: true });

      // 付与（外すロールがないので確認なし）
      await row.getByRole("button", { name: "ロールを変更" }).click();
      const roles = page.getByRole("group", { name: `${f.grader.user.name} さんのロール` });
      await roles.getByLabel("管理者", { exact: true }).check();
      await roles.getByRole("button", { name: "保存" }).click();
      await expect(page.getByRole("status")).toContainText("採点者・管理者にしました");
      await expect(row).toContainText("採点者・管理者");

      // 外す（確認ダイアログを出す）
      await row.getByRole("button", { name: "ロールを変更" }).click();
      await roles.getByLabel("管理者", { exact: true }).uncheck();
      await roles.getByRole("button", { name: "保存" }).click();
      const dialog = page.getByRole("dialog", { name: "ロールの削除" });
      await expect(dialog).toContainText("管理者のロールを外します");
      await page.screenshot({ path: testInfo.outputPath("admin-confirm.png"), fullPage: true });
      await dialog.getByRole("button", { name: "ロールを外す" }).click();
      await expect(page.getByRole("status")).toContainText("採点者にしました");
      await expect(row.getByRole("cell").nth(2)).toHaveText("採点者");
    });

    test("監査ログに、管理者によるロールの変更が残る", async ({ browser }, testInfo) => {
      await using s = await openPage(browser, f.webUrl, f.admin.session, "/admin/audit");
      const page = s.page;
      await page.getByRole("combobox", { name: "操作", exact: true }).selectOption("user.roles");
      const mine = page
        .getByRole("row")
        .filter({ hasText: `${f.admin.user.name}（管理者）` })
        .filter({ hasText: f.grader.user.name });
      // 直前のテストの付与と削除（新しい順）
      await expect(mine.first()).toContainText("削除管理者");
      await expect(mine.nth(1)).toContainText("付与管理者");
      await expect(mine.first()).toContainText("成功");
      await page.screenshot({ path: testInfo.outputPath("admin-audit.png"), fullPage: true });
    });

    test("管理者が候補者を登録し、無効化する", async ({ browser }, testInfo) => {
      await using s = await openPage(browser, f.webUrl, f.admin.session, "/admin/users");
      const page = s.page;
      await page.getByRole("button", { name: "利用者を登録する" }).click();
      const form = page.getByRole("form", { name: "利用者の登録" });
      await form.getByLabel("メールアドレス").fill(candidateEmail);
      await form.getByLabel("氏名").fill("E2E 画面登録");
      await page.screenshot({ path: testInfo.outputPath("admin-register.png"), fullPage: true });
      await form.getByRole("button", { name: "登録する" }).click();
      await expect(page.getByRole("status")).toContainText(
        "E2E 画面登録 さんを候補者として登録しました",
      );
      await expect(page.getByRole("status")).toContainText("/login");

      const row = page.getByRole("row").filter({ hasText: candidateEmail });
      await expect(row).toContainText("候補者");
      await row.getByRole("button", { name: "無効化" }).click();
      const dialog = page.getByRole("dialog", { name: "利用者の無効化" });
      await expect(dialog).toContainText("画面から有効に戻すことはできません");
      await dialog.getByRole("button", { name: "無効化する" }).click();
      await expect(page.getByRole("status")).toContainText("無効化しました");
      await expect(row).toContainText("無効");
    });
  });
