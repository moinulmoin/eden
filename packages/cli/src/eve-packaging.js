// Node's native TypeScript loader resolves this bridge when lifecycle fixtures
// import the source CLI directly. TypeScript resolves the same specifier to
// eve-packaging.ts for declarations and emits dist/eve-packaging.js.
export * from "./eve-packaging.ts";
