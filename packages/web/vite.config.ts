import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// ローカル開発時は /api をデプロイ済み環境の CloudFront へ転送する
// 例: HACCOLI_WEB_URL=https://xxxx.cloudfront.net npm run web:dev
const apiTarget = process.env.HACCOLI_WEB_URL;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: apiTarget ? { "/api": { target: apiTarget, changeOrigin: true } } : undefined,
  },
});
