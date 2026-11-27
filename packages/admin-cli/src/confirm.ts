import { createInterface } from "node:readline/promises";
import type { Context } from "./context.js";

/** 本番環境への変更操作のみ確認を求める（--yes で省略） */
export async function confirmIfProd(ctx: Context, message: string, yes: boolean): Promise<void> {
  if (ctx.env !== "prod" || yes) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`[prod] ${message} よろしいですか？ (yes/no): `);
    if (answer.trim().toLowerCase() !== "yes") {
      throw new Error("中止しました");
    }
  } finally {
    rl.close();
  }
}

/** 取り返しのつかない操作は、環境を問わず確認を求める（--yes で省略） */
export async function confirmAlways(ctx: Context, message: string, yes: boolean): Promise<void> {
  if (yes) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`[${ctx.env}] ${message} よろしいですか？ (yes/no): `);
    if (answer.trim().toLowerCase() !== "yes") {
      throw new Error("中止しました");
    }
  } finally {
    rl.close();
  }
}
