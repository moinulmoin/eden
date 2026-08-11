import { writeFile } from "node:fs/promises";
import process from "node:process";
import { setInterval } from "node:timers";

import { runEdenCli } from "../src/index.ts";

const [
  command,
  projectRoot,
  boundary,
  target,
  readyPath,
] = process.argv.slice(2);

if (
  (command !== "init" && command !== "build") ||
  typeof projectRoot !== "string" ||
  projectRoot.length === 0 ||
  typeof boundary !== "string" ||
  boundary.length === 0 ||
  typeof readyPath !== "string" ||
  readyPath.length === 0
) {
  throw new Error("publication crash child arguments are invalid");
}

const pauseAtBoundary = async (observedBoundary, observedTarget) => {
  if (
    observedBoundary !== boundary ||
    (target.length > 0 && observedTarget !== target)
  ) {
    return;
  }
  await writeFile(
    readyPath,
    JSON.stringify({
      boundary: observedBoundary,
      target: observedTarget,
    }),
    {
      encoding: "utf8",
      flag: "wx",
    },
  );
  await new Promise(() => {
    setInterval(() => undefined, 1_000);
  });
};

const exitCode = await runEdenCli(
  [command, "--project", projectRoot],
  {
    cwd: projectRoot,
    dryRunRunner: async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }),
    initPublicationHook: pauseAtBoundary,
    buildPublicationHook: pauseAtBoundary,
  },
);

process.exitCode = exitCode;
