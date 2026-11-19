import { Layout } from "./Layout.js";

/** 採点者のトップ（担当一覧）。採点機能は Step 5 で実装 */
export function GraderHomePage() {
  return (
    <Layout userRole="grader">
      <h1>担当一覧</h1>
      <p>現在、担当している採点はありません。</p>
    </Layout>
  );
}
