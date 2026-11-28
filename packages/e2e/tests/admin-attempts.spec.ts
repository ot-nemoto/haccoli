import type { Context } from "@haccoli/admin-cli/context";
import { jstDate, type UserProfile } from "@haccoli/core";
import { expect, test } from "@playwright/test";
import {
  EXAM_ID,
  openPage,
  prepareCandidate,
  prepareStaff,
  type StaffFixture,
  setUp,
  tearDown,
  tearDownStaff,
} from "../src/fixture.js";

/**
 * 管理画面の受験（docs/design.md §14.7）。常設の管理者 e2e-admin が、この実行で登録した候補者に
 * 画面から受験を発行し、採点者（e2e-grader）の割り当て・期限の変更・取消を行う。
 * 候補者は終了時に user:purge と同じ処理で削除する。
 */
test.describe
  .serial("管理画面の受験", () => {
    let ctx: Context;
    let f: StaffFixture;
    let candidateEmail: string;
    let candidate: UserProfile;
    /** 画面から発行した受験 */
    let attemptId: string;

    test.beforeAll(async () => {
      ({ ctx, candidateEmail } = await setUp());
      candidate = await prepareCandidate(ctx, candidateEmail);
      f = await prepareStaff(ctx);
    });

    test.afterAll(async () => {
      if (!ctx) return;
      await Promise.allSettled([tearDown(ctx, candidateEmail), tearDownStaff(ctx)]).then((r) => {
        const failed = r.filter((x) => x.status === "rejected");
        if (failed.length > 0) throw (failed[0] as PromiseRejectedResult).reason;
      });
    });

    test("管理者が画面から受験を発行し、詳細を開く", async ({ browser }, testInfo) => {
      await using s = await openPage(browser, f.webUrl, f.admin.session, "/admin/attempts");
      const page = s.page;
      await expect(page.getByRole("heading", { name: "受験", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "受験を発行する" }).click();
      const form = page.getByRole("form", { name: "受験の発行" });
      await form.getByLabel("候補者のメールアドレス").fill(candidateEmail);
      await form.getByRole("combobox", { name: "課題" }).selectOption(EXAM_ID);
      await page.screenshot({ path: testInfo.outputPath("attempt-issue.png"), fullPage: true });
      await form.getByRole("button", { name: "発行する" }).click();
      const notice = page.getByRole("status");
      await expect(notice).toContainText(`${candidate.name} さんに`);
      await expect(notice).toContainText("を発行しました");

      // 発行した受験は一覧の「未着手」に出る
      await page.getByRole("combobox", { name: "状態" }).selectOption("NOT_STARTED");
      await expect(page).toHaveURL(/status=NOT_STARTED/);
      const row = page
        .getByRole("table", { name: "受験の一覧" })
        .getByRole("row")
        .filter({ hasText: candidate.name });
      await expect(row).toContainText("未着手");
      await expect(row).toContainText("未割り当て");
      await page.screenshot({ path: testInfo.outputPath("attempts.png"), fullPage: true });

      await notice.getByRole("link", { name: "詳細を開く" }).click();
      await expect(page.getByRole("heading", { level: 1 })).toContainText(candidate.name);
      attemptId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop() ?? "");
      expect(attemptId).toMatch(/^[0-9a-f-]{36}$/);
      await expect(page.getByText(candidateEmail)).toBeVisible();
      await expect(page.getByRole("region", { name: "採点者" })).toContainText(
        "まだ割り当てていません",
      );
    });

    test("管理者が採点者を割り当て、期限を変更する", async ({ browser }, testInfo) => {
      await using s = await openPage(
        browser,
        f.webUrl,
        f.admin.session,
        `/admin/attempts/${attemptId}`,
      );
      const page = s.page;
      const actions = page.getByRole("region", { name: "受験の操作" });

      await actions.getByRole("checkbox", { name: f.grader.user.name, exact: true }).check();
      await actions.getByRole("button", { name: "割り当てる" }).click();
      await expect(page.getByRole("status")).toContainText(
        `${f.grader.user.name} さんを採点者に割り当てました`,
      );
      const graders = page.getByRole("table", { name: "採点者の一覧" });
      await expect(graders).toContainText(f.grader.user.name);
      await expect(graders).toContainText("未採点");
      // 割り当て済みの採点者は、選択肢から外れる
      await expect(
        actions.getByRole("checkbox", { name: f.grader.user.name, exact: true }),
      ).toHaveCount(0);

      // 期限を 2 日後にする（ダッシュボードの「期限が近い受験」に入る）
      const soon = jstDate(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000));
      await actions.getByLabel("新しい期限日").fill(soon);
      await actions.getByRole("button", { name: "期限を変更" }).click();
      await expect(page.getByRole("status")).toContainText(
        `期限を ${soon.replaceAll("-", "/")} 23:59 に変更しました`,
      );
      // 通知と同時に、上部の期限も新しい期限になっている
      await expect(page.locator("dl.attempt-meta")).toContainText(
        `${soon.replaceAll("-", "/")} 23:59`,
      );
      await page.screenshot({ path: testInfo.outputPath("attempt-detail.png"), fullPage: true });
    });

    test("ダッシュボードに、期限が近い受験と状態ごとの件数が出る", async ({
      browser,
    }, testInfo) => {
      await using s = await openPage(browser, f.webUrl, f.admin.session, "/admin");
      const page = s.page;
      await expect(page.getByRole("heading", { name: "ダッシュボード" })).toBeVisible();
      await expect(page.getByRole("link", { name: "ダッシュボード" })).toHaveClass(/active/);
      const dueSoon = page.getByRole("table", { name: "期限が近い受験" });
      await expect(dueSoon.getByRole("row").filter({ hasText: candidate.name })).toContainText(
        "1 人",
      );
      await page.screenshot({ path: testInfo.outputPath("dashboard.png"), fullPage: true });

      // 件数から、その状態の一覧へ移る
      const counts = page.getByRole("list", { name: "状態ごとの受験数" });
      await counts.getByRole("link", { name: /未着手/ }).click();
      await expect(page).toHaveURL(/\/admin\/attempts\?status=NOT_STARTED$/);
      await expect(page.getByRole("combobox", { name: "状態" })).toHaveValue("NOT_STARTED");
      await expect(page.getByRole("table", { name: "受験の一覧" })).toContainText(candidate.name);
    });

    test("管理者が受験を取り消す（確認ダイアログを出す）", async ({ browser }, testInfo) => {
      await using s = await openPage(
        browser,
        f.webUrl,
        f.admin.session,
        `/admin/attempts/${attemptId}`,
      );
      const page = s.page;
      await page.getByRole("button", { name: "受験を取り消す" }).click();
      const dialog = page.getByRole("dialog", { name: "受験の取消" });
      await expect(dialog).toContainText("元に戻すことはできません");
      await page.screenshot({ path: testInfo.outputPath("attempt-cancel.png"), fullPage: true });
      await dialog.getByRole("button", { name: "取り消す" }).click();
      await expect(page.getByRole("status")).toContainText("受験を取り消しました");
      await expect(page.locator("dl.attempt-meta")).toContainText("取消");
      // 取消の受験には、期限の変更・取消・割り当てを出さない
      await expect(page.getByRole("region", { name: "受験の操作" })).toHaveCount(0);
    });

    test("監査ログに、管理者による受験の操作が残る", async ({ browser }, testInfo) => {
      await using s = await openPage(browser, f.webUrl, f.admin.session, "/admin/audit");
      const page = s.page;
      const mine = page
        .getByRole("row")
        .filter({ hasText: `${f.admin.user.name}（管理者）` })
        .filter({ hasText: attemptId });
      // 新しい順：取消 → 期限の変更 → 割り当て → 発行
      await expect(mine).toHaveCount(4);
      await expect(mine.nth(0)).toContainText("受験の取消");
      await expect(mine.nth(0)).toContainText("変更前の状態未着手");
      await expect(mine.nth(1)).toContainText("期限の変更");
      await expect(mine.nth(1)).toContainText("変更後の期限");
      await expect(mine.nth(2)).toContainText("採点者の割り当て");
      await expect(mine.nth(2)).toContainText(
        `採点者${f.grader.user.name}（${f.grader.user.sub}）`,
      );
      await expect(mine.nth(3)).toContainText("受験の発行");
      await expect(mine.nth(3)).toContainText(`候補者${candidate.name}（${candidate.sub}）`);
      await page.screenshot({ path: testInfo.outputPath("audit-attempts.png"), fullPage: true });
      // 対象の受験から詳細へ移る
      await mine.nth(0).getByRole("link").click();
      await expect(page).toHaveURL(new RegExp(`/admin/attempts/${attemptId}$`));
    });
  });
