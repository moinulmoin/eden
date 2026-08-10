import type {
  EdenStandardSchemaV1,
  EdenToolDefinition,
} from "@eden/definitions";

interface GreetInput {
  readonly name: string;
}

const inputSchema: EdenStandardSchemaV1<GreetInput> = {
  "~standard": {
    version: 1,
    vendor: "eden-example",
    validate(value) {
      if (
        typeof value !== "object" ||
        value === null ||
        typeof (value as { name?: unknown }).name !== "string"
      ) {
        return {
          issues: [{ message: "name must be a string", path: ["name"] }],
        };
      }
      return { value: { name: (value as { name: string }).name.trim() } };
    },
  },
};

const greet: EdenToolDefinition<GreetInput, { readonly greeting: string }> = {
  description: "Greet a person by name.",
  inputSchema,
  execute(input) {
    return { greeting: `Hello, ${input.name}!` };
  },
};

export default greet;
