// Node's native TypeScript loader resolves this bridge when the lifecycle
// crash fixture imports the source CLI directly. TypeScript resolves the same
// specifier to eve.ts for declarations and emits dist/eve.js for the package.
export * from "./eve.ts";
