// One `npx vitest run` covers core and the UI; each package can still run alone.
import { defineConfig } from "vitest/config";

// `sous-source` picks the workspace's TypeScript source over the core's dist.
export default defineConfig({
  resolve: { conditions: ["sous-source"] },
  test: { projects: ["./packages/core/vitest.config.ts", "./packages/ui/vitest.config.ts"] },
});
