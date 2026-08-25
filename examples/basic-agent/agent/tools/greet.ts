import { z } from "zod";

import type {
  EdenToolDefinition,
} from "@moinulmoin/eden-definitions";

interface GreetInput {
  readonly name: string;
}

const inputSchema = z.object({
  name: z.string().trim().min(1),
});

const greet: EdenToolDefinition<GreetInput, { readonly greeting: string }> = {
  description: "Greet a person by name.",
  inputSchema,
  execute(input) {
    return { greeting: `Hello, ${input.name}!` };
  },
};

export default greet;
