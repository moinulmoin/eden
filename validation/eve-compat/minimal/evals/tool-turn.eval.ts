import { defineEval } from "eve/evals";

export default defineEval({
  description: "A hosted Eve agent can complete an authored tool turn.",
  async test(t) {
    const turn = await t.send(
      "Call compatibility_echo exactly once with the label eden-cloudflare-proof.",
    );

    turn.expectOk();
    turn.calledTool("compatibility_echo", {
      input: { label: "eden-cloudflare-proof" },
      output: {
        echoed: "eden-cloudflare-proof",
        runtime: "eve-on-eden",
      },
      count: 1,
    });
  },
});
