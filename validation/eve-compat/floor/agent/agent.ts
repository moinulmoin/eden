import { defineAgent } from "eve";

export default defineAgent({
  experimental: { workflow: { world: "@workflow/world-postgres" } },
  model: "minimax/minimax-m3-free",
  modelContextWindowTokens: 32_000,
  modelOptions: {
    providerOptions: {
      gateway: {
        models: [
          "poolside/laguna-s-2.1-free",
          "alibaba/qwen3.7-flash",
        ],
      },
    },
  },
});
