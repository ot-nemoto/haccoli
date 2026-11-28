import {
  AUDIT_ACTIONS,
  type AuditAction,
  type AuditRecord,
  auditMonth,
  listAuditLogs,
} from "@haccoli/core";
import { AUDIT_STATUS_LABELS } from "@haccoli/shared";
import type { Command } from "commander";
import { createContext } from "./context.js";

type Globals = () => { env: string; yes: boolean };

const jst = (iso: string) =>
  new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false });

/** yyyymm または yyyy-mm を受け付ける */
export function parseMonth(value: string): string {
  const m = /^(\d{4})-?(\d{2})$/.exec(value.trim());
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) {
    throw new Error(`--month は YYYY-MM の形式で指定してください: ${value}`);
  }
  return `${m[1]}${m[2]}`;
}

export function actorLabel(actor: AuditRecord["actor"]): string {
  return actor.type === "admin" ? `${actor.name}（管理者 ${actor.sub}）` : actor.arn;
}

export function addAuditCommands(program: Command, globals: Globals) {
  program
    .command("audit:list")
    .description("監査ログの一覧（月ごと、新しい順）")
    .option("--month <YYYY-MM>", "対象の月（JST。省略時は今月）")
    .option("--action <action>", `操作の種類で絞り込む（${AUDIT_ACTIONS.join(" / ")}）`)
    .action(async (opts: { month?: string; action?: string }) => {
      if (opts.action && !(AUDIT_ACTIONS as readonly string[]).includes(opts.action)) {
        throw new Error(`--action は ${AUDIT_ACTIONS.join(" / ")} のいずれかです`);
      }
      const month = opts.month ? parseMonth(opts.month) : auditMonth(new Date());
      const ctx = await createContext(globals().env);
      const logs = await listAuditLogs(ctx.deps, {
        month,
        action: opts.action as AuditAction | undefined,
      });
      if (logs.length === 0) {
        console.log(`${month.slice(0, 4)}-${month.slice(4)} の監査ログはありません`);
        return;
      }
      console.table(
        logs.map((l) => ({
          at: jst(l.at),
          actor: actorLabel(l.actor),
          action: l.action,
          target: l.target ? `${l.target.type}:${l.target.id}` : "",
          status: AUDIT_STATUS_LABELS[l.status],
          detail: JSON.stringify(l.detail ?? {}),
          error: l.error ?? "",
        })),
      );
      const unknown = logs.filter((l) => l.status === "STARTED").length;
      if (unknown > 0) {
        console.log(
          `結果不明が ${unknown} 件あります。実行中でなければ、対象の状態を確かめてください。`,
        );
      }
    });
}
