// The browser app. `npm run dev` serves it with hot reload and forwards
// /api to a running `sous ui` (default port 4680); `vite build` writes dist/,
// which `sous ui` serves itself.
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env["SOUS_UI_API"] ?? "http://127.0.0.1:4680";

export default defineConfig({
  root: "src",
  plugins: [react(), tailwindcss()],
  // A local tool served from disk; one bundle is fine.
  build: { outDir: "../dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: { proxy: { "/api": { target: api, changeOrigin: true } } },
});
