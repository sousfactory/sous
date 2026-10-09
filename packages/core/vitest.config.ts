import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["sous-source"] },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
