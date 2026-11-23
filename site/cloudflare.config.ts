import { defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "eden-site",
    compatibilityDate: "2026-09-30",
    assets: {
      notFoundHandling: "404-page",
    },
    domains: ["eden.ideaplexa.com"],
  },
});
