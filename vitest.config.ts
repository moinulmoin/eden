import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "test/**/*.test.mjs",
      "packages/**/test/**/*.test.ts",
      "examples/**/test/**/*.test.ts",
    ],
    maxWorkers: 1,
    minWorkers: 1,
  },
});
