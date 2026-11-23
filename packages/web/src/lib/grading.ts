/** 点数の入力チェック。問題なければ undefined（サーバー側 validateGradeItems と同じ条件） */
export function scoreError(score: number | undefined, points: number | undefined) {
  if (score === undefined) return undefined;
  if (!Number.isFinite(score) || score < 0) return "0 以上の数値を入力してください";
  if (points !== undefined && score > points) return `${points} 点以下で入力してください`;
  return undefined;
}
