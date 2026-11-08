import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Echo a label for Eden hosting compatibility checks.",
  inputSchema: z.object({
    label: z.string(),
  }),
  async execute({ label }) {
    return {
      echoed: label,
      runtime: "eve-on-eden",
    };
  },
});
