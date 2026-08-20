// Node's native TypeScript loader resolves this bridge when the lifecycle
// crash fixture imports the source CLI directly. TypeScript resolves the same
// specifier to eve-runtime-config.ts for declarations and emits dist/eve-runtime-config.js.
export * from "./eve-runtime-config.ts";
