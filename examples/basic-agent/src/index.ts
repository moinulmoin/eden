import type { EdenAgentDefinition } from "@moinulmoin/eden-definitions";

export const basicAgent: EdenAgentDefinition = {
  model: "@cf/zai-org/glm-4.7-flash",
  options: {
    maxOutputTokens: 512,
    thinking: false,
  },
};

export default basicAgent;
