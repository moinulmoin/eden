import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "eden-telemetry",
    compatibilityDate: "2026-09-30",
    entrypoint: "./src/index.ts",
    domains: ["telemetry.eden.ideaplexa.com"],
    workersDev: false,
    previewUrls: false,
    observability: { enabled: false },
    env: {
      EVENTS: bindings.analyticsEngineDataset({ name: "eden_telemetry" }),
    },
  },
});
