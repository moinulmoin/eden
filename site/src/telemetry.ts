import readme from "../../README.md?raw";

/** The README's Telemetry section is the one description of the event; the site renders it from there. */
const section = readme.split(/^## /m).find((part) => part.startsWith("Telemetry\n"));
if (!section) throw new Error("README.md has no ## Telemetry section");

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = (text: string) => escape(text.replace(/\s+/g, " ").trim()).replace(/`([^`]+)`/g, "<code>$1</code>");

export const fields = section
  .split("\n")
  .map((line) => /^\| `(\w+)` \| (.+) \|$/.exec(line))
  .filter((match) => match !== null)
  .map(([, name, holds]) => ({ name: name!, holds: inline(holds!) }));
if (fields.length === 0) throw new Error("README.md#telemetry lists no fields");

const neverSent = section.split("\n\n").find((paragraph) => paragraph.startsWith("Eden never sends"));
if (!neverSent) throw new Error("README.md#telemetry does not say what is never sent");
export const never = inline(neverSent);
