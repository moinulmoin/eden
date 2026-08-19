// Node's native TypeScript loader resolves this bridge when lifecycle fixtures
// import the source CLI directly. TypeScript resolves the same specifier to
// eve-runtime-image.ts for declarations and emits dist/eve-runtime-image.js.
export * from "./eve-runtime-image.ts";
