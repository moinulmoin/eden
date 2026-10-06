import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": resolve(
        import.meta.dirname,
        "../../test/cloudflare-workers-stub.ts",
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    maxWorkers: 1,
  },
});
