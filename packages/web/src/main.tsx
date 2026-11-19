import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { loadRuntimeConfig } from "./config.js";
import "./styles.css";

const root = createRoot(document.getElementById("root") as HTMLElement);

loadRuntimeConfig()
  .then((config) => {
    root.render(
      <StrictMode>
        <App config={config} />
      </StrictMode>,
    );
  })
  .catch((e: unknown) => {
    console.error(e);
    root.render(<p className="error">設定の読み込みに失敗しました。</p>);
  });
