const JST = "Asia/Tokyo";

/** 日時を JST で表示する（例: 2026/11/30 23:59） */
export function formatJst(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", {
    timeZone: JST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** 時刻のみ（最終保存時刻の表示用） */
export function formatJstTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("ja-JP", {
    timeZone: JST,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** 期限までの残り時間（docs/design.md §6.4「残り日数を常時表示」） */
export function remainingLabel(deadlineAt: string, now: Date = new Date()): string {
  const ms = new Date(deadlineAt).getTime() - now.getTime();
  if (ms <= 0) return "期限切れ";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `残り ${Math.max(minutes, 1)} 分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `残り ${hours} 時間`;
  return `残り ${Math.floor(hours / 24)} 日`;
}
