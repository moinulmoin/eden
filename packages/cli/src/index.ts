export const EDEN_CLI_COMMANDS = [
  "init",
  "dev",
  "build",
  "deploy",
] as const;

export type EdenCliCommand = (typeof EDEN_CLI_COMMANDS)[number];

export interface EdenCliInvocation {
  readonly command: EdenCliCommand;
  readonly projectRoot?: string;
}

export interface EdenCliResult {
  readonly command: EdenCliCommand;
  readonly ok: boolean;
}

export function isEdenCliCommand(value: string): value is EdenCliCommand {
  return (EDEN_CLI_COMMANDS as readonly string[]).includes(value);
}
