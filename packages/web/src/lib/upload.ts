/**
 * 署名付き POST で S3 へ直接アップロードする（docs/design.md §6.2）。
 * 進捗を取るため fetch ではなく XMLHttpRequest を使う。
 */
export class UploadError extends Error {}

export function uploadToS3(
  target: { url: string; fields: Record<string, string> },
  file: File,
  onProgress: (percent: number) => void,
): Promise<void> {
  const form = new FormData();
  for (const [k, v] of Object.entries(target.fields)) form.append(k, v);
  // S3 の POST では file は最後のフィールドでなければならない
  form.append("file", file);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", target.url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new UploadError(describeS3Error(xhr.responseText)));
    };
    xhr.onerror = () =>
      reject(new UploadError("アップロード中に通信が切れました。もう一度お試しください。"));
    xhr.send(form);
  });
}

function describeS3Error(xml: string): string {
  const code = /<Code>([^<]+)<\/Code>/.exec(xml)?.[1];
  switch (code) {
    case "EntityTooLarge":
      return "ファイルが大きすぎます。";
    case "AccessDenied":
      return "アップロードの有効期限が切れた可能性があります。もう一度お試しください。";
    default:
      return "アップロードに失敗しました。もう一度お試しください。";
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
