import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: [
            "test/**/*.test.mjs",
            "packages/**/test/**/*.test.ts",
            "examples/**/test/**/*.test.ts",
          ],
          exclude: [
            "packages/runtime-cloudflare/test/**",
            "**/node_modules/**",
          ],
          maxWorkers: 1,
          minWorkers: 1,
        },
      },
      "./packages/runtime-cloudflare/vitest.config.ts",
    ],
  },
});
