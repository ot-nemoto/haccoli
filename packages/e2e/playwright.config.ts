import { defineConfig, devices } from "@playwright/test";

/**
 * デプロイ済みの dev 環境に対する E2E テスト（README の「E2E テスト」）。
 * AWS の認証情報（dev アカウント）が必要。通常の CI（npm test）には含めない。
 */
export default defineConfig({
  testDir: "tests",
  // 受験・採点は 1 本の流れなので直列に実行する
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  outputDir: "test-results",
  use: {
    ...devices["Desktop Chrome"],
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
