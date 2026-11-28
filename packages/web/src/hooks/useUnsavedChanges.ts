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
      // 画面を離れないクリック（新しいタブ・ウィンドウで開く、ダウンロード、既に止められたもの）は確かめない
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      const link = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
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
