import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ["sous-source"] },
  test: {
    name: "ui",
    include: ["test/**/*.test.{ts,tsx}"],
    // Browser-side tests opt into jsdom with a `@vitest-environment jsdom` comment.
    css: false,
    // Primer ships CSS imports inside its modules; let Vite transform them.
    server: { deps: { inline: [/@primer\/react/] } },
  },
});
