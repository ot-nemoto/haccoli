import { Layout } from "./Layout.js";

/** 候補者のトップ（課題一覧）。課題機能は Step 3 で実装 */
export function CandidateHomePage() {
  return (
    <Layout userRole="candidate">
      <h1>採用課題</h1>
      <p>現在、表示できる課題はありません。</p>
    </Layout>
  );
}
