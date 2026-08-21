import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": resolve(
        import.meta.dirname,
        "test/cloudflare-workers-stub.ts",
      ),
    },
  },
  test: {
    projects: [
      {
        resolve: {
          alias: {
            "cloudflare:workers": resolve(
              import.meta.dirname,
              "test/cloudflare-workers-stub.ts",
            ),
          },
        },
        test: {
          server: {
            deps: {
              inline: ["@cloudflare/containers"],
            },
          },
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
