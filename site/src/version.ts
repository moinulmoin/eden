import cli from "../../packages/cli/package.json";

/** The published Eden CLI version, read at build time so the site never drifts. */
export const version = cli.version;
