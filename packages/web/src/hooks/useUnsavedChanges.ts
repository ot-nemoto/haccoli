import { useEffect } from "react";

/**
 * 保存していない変更があるときに、画面を離れようとしたら確かめる。
 * ブラウザを閉じる・再読み込みは beforeunload で、画面内のリンク（メニューなど）は
 * クリックを捕まえて確かめる（BrowserRouter では useBlocker を使えないため）
 */
export function useUnsavedChanges(dirty: boolean, message = UNSAVED_MESSAGE): void {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    const onClick = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.("a[href]");
      if (!link || (link as HTMLAnchorElement).target === "_blank") return;
      if (!window.confirm(message)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    // React Router のリンクより先に確かめるため、捕捉フェーズで受ける
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, message]);
}

export const UNSAVED_MESSAGE = "保存していない変更があります。このページを離れますか？";
