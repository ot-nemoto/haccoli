import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../lib/config.js";
import { HaccoliStack } from "../lib/haccoli-stack.js";

const ctx = (values: Record<string, string>) => (key: string) => values[key];
const ENV_KEYS = ["HACCOLI_SES_VERIFIED_DOMAIN", "HACCOLI_FROM_EMAIL"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("loadConfig（sesVerifiedDomain）", () => {
  const base = { env: "dev", fromEmail: "no-reply@recruit.example.jp" };

  it("未指定なら設定しない", () => {
    expect(loadConfig(ctx(base))).not.toHaveProperty("sesVerifiedDomain");
  });

  it("コンテキスト、または環境変数 HACCOLI_SES_VERIFIED_DOMAIN で指定できる", () => {
    expect(
      loadConfig(ctx({ ...base, sesVerifiedDomain: "recruit.example.jp" })).sesVerifiedDomain,
    ).toBe("recruit.example.jp");
    process.env.HACCOLI_SES_VERIFIED_DOMAIN = "recruit.example.jp";
    expect(loadConfig(ctx(base)).sesVerifiedDomain).toBe("recruit.example.jp");
    // 空文字は未指定として環境変数に切り替える
    expect(loadConfig(ctx({ ...base, sesVerifiedDomain: "" })).sesVerifiedDomain).toBe(
      "recruit.example.jp",
    );
  });

  it("前後の空白・大文字小文字の違いは吸収し、それ以外の不一致はエラー", () => {
    expect(
      loadConfig(ctx({ ...base, sesVerifiedDomain: " Recruit.Example.JP " })).sesVerifiedDomain,
    ).toBe("recruit.example.jp");
    expect(() => loadConfig(ctx({ ...base, sesVerifiedDomain: "example.jp" }))).toThrow(
      /一致しません/,
    );
    expect(() =>
      loadConfig(
        ctx({
          ...base,
          fromEmail: "a@mail.recruit.example.jp",
          sesVerifiedDomain: "recruit.example.jp",
        }),
      ),
    ).toThrow(/サブドメイン/);
  });

  it("空の環境変数は未指定として扱う", () => {
    // GitHub の Variable が未設定だと空文字で渡る
    process.env.HACCOLI_SES_VERIFIED_DOMAIN = "";
    expect(loadConfig(ctx(base))).not.toHaveProperty("sesVerifiedDomain");
  });
});

describe("Cognito の送信元（SES の ID）", () => {
  function sourceArn(values: Record<string, string>) {
    const distDir = mkdtempSync(join(tmpdir(), "haccoli-web-"));
    writeFileSync(join(distDir, "index.html"), "<!doctype html>");
    try {
      const stack = new HaccoliStack(new App(), "Haccoli-dev", {
        env: { account: "123456789012", region: "ap-northeast-1" },
        webDistDir: distDir,
        config: loadConfig(ctx(values)),
      });
      const pools = Template.fromStack(stack).findResources("AWS::Cognito::UserPool");
      return JSON.stringify(Object.values(pools)[0]?.Properties.EmailConfiguration.SourceArn);
    } finally {
      rmSync(distDir, { recursive: true, force: true });
    }
  }

  it("ドメインを指定するとドメインの ID、指定しなければアドレスの ID を使う", () => {
    const from = { env: "dev", fromEmail: "no-reply@recruit.example.jp" };
    expect(sourceArn({ ...from, sesVerifiedDomain: "recruit.example.jp" })).toContain(
      "identity/recruit.example.jp",
    );
    expect(sourceArn(from)).toContain("identity/no-reply@recruit.example.jp");
  }, 120_000);
});
