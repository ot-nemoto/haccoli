import { createHash, randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  type S3Client,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NotFoundError, ValidationError } from "./errors.js";

/**
 * 提出ファイルの保存先（docs/design.md §6.2）。S3 の実装をテストで差し替えられるように抽象化する。
 */
export interface FileStore {
  /** ブラウザから直接アップロードするための署名付き POST（サイズ上限を S3 側で強制） */
  createUploadPost(
    key: string,
    maxBytes: number,
  ): Promise<{ url: string; fields: Record<string, string> }>;
  /** アップロード済みファイルを読み、サイズ・先頭バイト・SHA-256 を返す */
  inspect(key: string, maxBytes: number): Promise<{ size: number; head: Buffer; sha256: string }>;
  delete(key: string): Promise<void>;
  /** 採点者のダウンロード用の署名付き GET（attachment 指定） */
  createDownloadUrl(key: string, fileName: string): Promise<string>;
}

/** 署名付き GET の有効期限（§6.2） */
export const DOWNLOAD_URL_EXPIRES_SECONDS = 300;

/**
 * Content-Disposition: attachment。日本語名は RFC 5987 の filename* で渡し、
 * filename には ASCII に置き換えた名前を入れる（ヘッダーインジェクション防止）。
 */
export function attachmentDisposition(fileName: string): string {
  const display = displayFileName(fileName) || "submission.zip";
  const ascii = storageFileName(display);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(display)}`;
}

/** encodeURIComponent がそのまま残す ' ( ) * ! も、RFC 5987 の attr-char にないので %XX にする */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*!]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** 署名付き POST の有効期限（§6.2） */
export const UPLOAD_URL_EXPIRES_SECONDS = 300;

/** zip のマジックナンバー（ローカルファイルヘッダ）。§5.2 */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export function fileKeyPrefix(attemptId: string, qid: string): string {
  return `attempts/${attemptId}/${qid}/`;
}

/** attempts/<attemptId>/<qid>/<uuid>/<sanitizedFileName> */
export function newFileKey(attemptId: string, qid: string, fileName: string): string {
  return `${fileKeyPrefix(attemptId, qid)}${randomUUID()}/${storageFileName(fileName)}`;
}

/** S3 のキーに使うファイル名。英数字と . _ - 以外は _ に置き換える */
export function storageFileName(fileName: string): string {
  const base = displayFileName(fileName);
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  const trimmed = safe.length > 100 ? `${safe.slice(0, 96)}.zip` : safe;
  return trimmed || "submission.zip";
}

/** 表示用のファイル名。パス区切り・制御文字を除き 200 文字に切り詰める */
export function displayFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を除去するため
  return [...base.replace(/[\u0000-\u001f\u007f]/g, "").trim()].slice(0, 200).join("");
}

export function assertZipFileName(fileName: string): void {
  if (!/\.zip$/i.test(fileName))
    throw new ValidationError("zip ファイル（.zip）を選択してください");
}

/**
 * アップロードされたファイルを検証して、保存する回答内容を作る（§5.2）。
 * キーがこの受験・問題の配下か、サイズ、zip のマジックナンバーを確認し、SHA-256 を記録する。
 */
export async function verifyUploadedFile(
  files: FileStore,
  input: { attemptId: string; qid: string; fileKey: string; fileName: string; maxBytes: number },
  now: Date,
) {
  const prefix = fileKeyPrefix(input.attemptId, input.qid);
  if (!input.fileKey.startsWith(prefix) || input.fileKey.includes("..")) {
    throw new ValidationError("ファイルの指定が不正です");
  }
  const fileName = displayFileName(input.fileName);
  assertZipFileName(fileName);
  const info = await files.inspect(input.fileKey, input.maxBytes);
  if (info.size === 0) throw new ValidationError("空のファイルは提出できません");
  if (!info.head.subarray(0, 4).equals(ZIP_MAGIC)) {
    throw new ValidationError("zip 形式のファイルではありません");
  }
  return {
    fileKey: input.fileKey,
    fileName,
    size: info.size,
    sha256: info.sha256,
    uploadedAt: now.toISOString(),
  };
}

export function s3FileStore(s3: S3Client, bucket: string): FileStore {
  return {
    async createUploadPost(key, maxBytes) {
      const { url, fields } = await createPresignedPost(s3, {
        Bucket: bucket,
        Key: key,
        Conditions: [["content-length-range", 1, maxBytes]],
        Fields: { "Content-Type": "application/zip" },
        Expires: UPLOAD_URL_EXPIRES_SECONDS,
      });
      return { url, fields };
    },

    async inspect(key, maxBytes) {
      let res: GetObjectCommandOutput;
      try {
        res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      } catch (e) {
        if (e instanceof Error && (e.name === "NoSuchKey" || e.name === "NotFound")) {
          throw new NotFoundError("アップロードされたファイルが見つかりません");
        }
        throw e;
      }
      const body = res.Body as Readable | undefined;
      const size = res.ContentLength ?? 0;
      if (size > maxBytes) {
        body?.destroy();
        throw new ValidationError(
          `ファイルが大きすぎます（上限 ${Math.floor(maxBytes / 1024 / 1024)}MB）`,
        );
      }
      const hash = createHash("sha256");
      const chunks: Buffer[] = [];
      let headLength = 0;
      let read = 0;
      for await (const chunk of body ?? []) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        read += buf.length;
        if (read > maxBytes) {
          body?.destroy();
          throw new ValidationError("ファイルが大きすぎます");
        }
        hash.update(buf);
        if (headLength < 4) {
          chunks.push(buf);
          headLength += buf.length;
        }
      }
      return { size: read, head: Buffer.concat(chunks).subarray(0, 4), sha256: hash.digest("hex") };
    },

    async delete(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    async createDownloadUrl(key, fileName) {
      return getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ResponseContentDisposition: attachmentDisposition(fileName),
          ResponseContentType: "application/zip",
        }),
        { expiresIn: DOWNLOAD_URL_EXPIRES_SECONDS },
      );
    },
  };
}
