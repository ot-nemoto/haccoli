import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { NotFoundError, ValidationError } from "./errors.js";
import {
  displayFileName,
  type FileStore,
  newFileKey,
  s3FileStore,
  storageFileName,
  verifyUploadedFile,
} from "./files.js";

const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("rest of zip")]);

describe("ファイル名", () => {
  it.each([
    ["../../etc/passwd.zip", "passwd.zip", "passwd.zip"],
    ["C:\\Users\\me\\提出 課題.zip", "提出 課題.zip", "_____.zip"],
    [".hidden.zip", ".hidden.zip", "_hidden.zip"],
    ["a\u0000b\u001f.zip", "ab.zip", "ab.zip"],
  ])("%j → 表示 %j / キー %j", (input, display, storage) => {
    expect(displayFileName(input)).toBe(display);
    expect(storageFileName(input)).toBe(storage);
  });

  it("長いファイル名は切り詰めても .zip を保つ", () => {
    expect(storageFileName(`${"a".repeat(300)}.zip`)).toMatch(/^a{96}\.zip$/);
  });

  it("キーは受験・問題の配下に一意に作る", () => {
    const k1 = newFileKey("at1", "q3", "x.zip");
    const k2 = newFileKey("at1", "q3", "x.zip");
    expect(k1).toMatch(/^attempts\/at1\/q3\/[0-9a-f-]{36}\/x\.zip$/);
    expect(k1).not.toBe(k2);
  });
});

describe("verifyUploadedFile", () => {
  const store = (inspect: Partial<Awaited<ReturnType<FileStore["inspect"]>>> = {}): FileStore => ({
    createUploadPost: async () => ({ url: "", fields: {} }),
    inspect: async () => ({
      size: ZIP.length,
      head: ZIP.subarray(0, 4),
      sha256: "abc",
      ...inspect,
    }),
    delete: async () => undefined,
    createDownloadUrl: async () => "",
  });
  const input = {
    attemptId: "at1",
    qid: "q3",
    fileKey: "attempts/at1/q3/u/x.zip",
    fileName: "提出.zip",
    maxBytes: 1024,
  };
  const now = new Date("2026-11-21T00:00:00Z");

  it("検証して回答内容を返す", async () => {
    await expect(verifyUploadedFile(store(), input, now)).resolves.toEqual({
      fileKey: "attempts/at1/q3/u/x.zip",
      fileName: "提出.zip",
      size: ZIP.length,
      sha256: "abc",
      uploadedAt: "2026-11-21T00:00:00.000Z",
    });
  });

  it.each([
    ["他の受験のキー", { fileKey: "attempts/other/q3/u/x.zip" }],
    ["他の問題のキー", { fileKey: "attempts/at1/q1/u/x.zip" }],
    ["パスの遡り", { fileKey: "attempts/at1/q3/../../other/x.zip" }],
    ["zip 以外の名前", { fileName: "x.tar.gz" }],
  ])("%s は ValidationError", async (_, over) => {
    await expect(verifyUploadedFile(store(), { ...input, ...over }, now)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("マジックナンバーが zip でなければ拒否する", async () => {
    await expect(
      verifyUploadedFile(store({ head: Buffer.from("%PDF") }), input, now),
    ).rejects.toThrow("zip 形式");
  });

  it("空のファイルは拒否する", async () => {
    await expect(verifyUploadedFile(store({ size: 0 }), input, now)).rejects.toThrow("空");
  });
});

describe("s3FileStore.inspect", () => {
  const s3 = new S3Client({ region: "ap-northeast-1" });
  const s3Mock = mockClient(s3);
  const files = s3FileStore(s3, "bucket");
  beforeEach(() => s3Mock.reset());

  const body = (chunks: Buffer[]) => Readable.from(chunks) as never;

  it("分割されたストリームでも SHA-256 と先頭 4 バイトを求める", async () => {
    s3Mock.on(GetObjectCommand).resolves({
      ContentLength: ZIP.length,
      Body: body([ZIP.subarray(0, 2), ZIP.subarray(2, 3), ZIP.subarray(3)]),
    });
    const info = await files.inspect("k", 1024);
    expect(info.size).toBe(ZIP.length);
    expect(info.head).toEqual(ZIP.subarray(0, 4));
    expect(info.sha256).toBe(createHash("sha256").update(ZIP).digest("hex"));
  });

  it("上限を超えるファイルは読まずに拒否する", async () => {
    s3Mock.on(GetObjectCommand).resolves({ ContentLength: 2048, Body: body([ZIP]) });
    await expect(files.inspect("k", 1024)).rejects.toThrow("大きすぎ");
  });

  it("存在しないキーは NotFound", async () => {
    s3Mock.on(GetObjectCommand).rejects(Object.assign(new Error("x"), { name: "NoSuchKey" }));
    await expect(files.inspect("k", 1024)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("attachmentDisposition", () => {
  it("日本語名は filename* で渡し、filename は ASCII にする（引用符・改行を含めない）", async () => {
    const { attachmentDisposition } = await import("./files.js");
    const v = attachmentDisposition('提出"\r\nX: y.zip');
    expect(v).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"; filename\*=UTF-8''/);
    expect(v).not.toMatch(/[\r\n]/);
    expect(v.split('"').length).toBe(3);
  });
});
