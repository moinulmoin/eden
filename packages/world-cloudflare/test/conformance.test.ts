import { createTestSuite } from "@workflow/world-testing";
import { fileURLToPath } from "node:url";

process.env.CBOR_NATIVE_ACCELERATION_DISABLED = "true";
const preload = fileURLToPath(new URL("./preload.mjs", import.meta.url));
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --import=${preload}`;
createTestSuite(fileURLToPath(new URL("../dist/index.js", import.meta.url)));
