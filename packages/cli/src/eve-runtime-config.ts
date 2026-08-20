import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  lstat,
  readFile,
} from "node:fs/promises";
import {
  resolve,
} from "node:path";

export const EVE_RESERVED_HOST_VARIABLES = Object.freeze([
  "HOST",
  "NITRO_HOST",
  "PORT",
  "NITRO_PORT",
  "NODE_ENV",
  "WORKFLOW_LOCAL_BASE_URL",
  "EDEN_EVE_DEPLOYMENT_ID",
  "EDEN_EVE_GENERATION_ID",
]) as readonly [
  "HOST",
  "NITRO_HOST",
  "PORT",
  "NITRO_PORT",
  "NODE_ENV",
  "WORKFLOW_LOCAL_BASE_URL",
  "EDEN_EVE_DEPLOYMENT_ID",
  "EDEN_EVE_GENERATION_ID",
];

export type EveReservedHostVariable =
  (typeof EVE_RESERVED_HOST_VARIABLES)[number];

export const EVE_START_COMMAND = Object.freeze([
  "./node_modules/.bin/eve",
  "start",
  "--host",
  "0.0.0.0",
  "--port",
  "8080",
]) as readonly [
  "./node_modules/.bin/eve",
  "start",
  "--host",
  "0.0.0.0",
  "--port",
  "8080",
];

const EVE_ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const EVE_RUNTIME_METADATA_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const EVE_ENV_FILE_SOURCE = "--env-file";

type EveRuntimeValueMap = Readonly<Record<string, string>>;

export type EveRuntimeConfigErrorCode =
  | "EVE_ENV_FILE_NOT_FOUND"
  | "EVE_ENV_FILE_INVALID"
  | "EVE_ENV_FILE_UNREADABLE"
  | "EVE_ENV_FILE_ENCODING"
  | "EVE_ENV_FILE_MALFORMED"
  | "EVE_ENV_FILE_DUPLICATE"
  | "EVE_ENV_RESERVED_VARIABLE"
  | "EVE_ENV_FILE_RACE"
  | "EVE_RUNTIME_INJECTION_INVALID"
  | "EVE_RUNTIME_PROTECTED_STORE_UNAVAILABLE"
  | "EVE_RUNTIME_PROTECTED_UPLOAD_FAILED"
  | "EVE_RUNTIME_LOCAL_INJECTION_UNSUPPORTED";

export class EveRuntimeConfigError extends Error {
  readonly code: EveRuntimeConfigErrorCode;
  readonly source: string | undefined;
  readonly variableName: string | undefined;

  constructor(options: {
    readonly code: EveRuntimeConfigErrorCode;
    readonly message: string;
    readonly source?: string;
    readonly variableName?: string;
  }) {
    super(options.message);
    this.name = "EveRuntimeConfigError";
    this.code = options.code;
    this.source = options.source;
    this.variableName = options.variableName;
  }
}

export interface EveRuntimeInputIdentity {
  readonly token: string;
  readonly byteLength: number;
  readonly digest: string;
}

export interface RedactedRuntimeConfigSeam {
  readonly supplied: true;
  readonly inputIdentity: EveRuntimeInputIdentity;
  readonly variableNames: readonly string[];
  readonly reservedHostNames: readonly EveReservedHostVariable[];
  readonly protectedRevision: string;
  readonly redactionHandle: string;
  readonly excludedFromBuildInputs: true;
}

interface EveRuntimeFileObservation {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly size: number;
  readonly bytes: Buffer;
  readonly digest: string;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function isPermissionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["EACCES", "EPERM", "EISDIR"].includes(
      String((error as { readonly code?: unknown }).code),
    )
  );
}

function fileObservationMatches(
  left: EveRuntimeFileObservation,
  right: EveRuntimeFileObservation,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.digest === right.digest &&
    left.bytes.equals(right.bytes)
  );
}

function invalidPathError(
  reason: string,
): EveRuntimeConfigError {
  return new EveRuntimeConfigError({
    code: "EVE_ENV_FILE_INVALID",
    message: `The explicit Eve environment file is invalid: ${reason}.`,
    source: EVE_ENV_FILE_SOURCE,
  });
}

async function observeEnvironmentFile(path: string): Promise<EveRuntimeFileObservation> {
  const before = await lstat(path).catch((error: unknown) => {
    if (isMissingError(error)) {
      throw new EveRuntimeConfigError({
        code: "EVE_ENV_FILE_NOT_FOUND",
        message: "The explicit Eve environment file does not exist.",
        source: EVE_ENV_FILE_SOURCE,
      });
    }
    throw new EveRuntimeConfigError({
      code: "EVE_ENV_FILE_UNREADABLE",
      message: "The explicit Eve environment file could not be inspected safely.",
      source: EVE_ENV_FILE_SOURCE,
    });
  });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw invalidPathError(
      "it must be a regular file and symbolic links are not accepted",
    );
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error: unknown) {
    throw new EveRuntimeConfigError({
      code: isPermissionError(error)
        ? "EVE_ENV_FILE_UNREADABLE"
        : "EVE_ENV_FILE_INVALID",
      message: "The explicit Eve environment file could not be read safely.",
      source: EVE_ENV_FILE_SOURCE,
    });
  }

  const secondBytes = await readFile(path).catch(() => undefined);
  const after = await lstat(path).catch((error: unknown) => {
    if (isMissingError(error)) return undefined;
    return undefined;
  });
  if (
    secondBytes === undefined ||
    !bytes.equals(secondBytes) ||
    after === undefined ||
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.mode !== before.mode ||
    after.size !== before.size
  ) {
    throw new EveRuntimeConfigError({
      code: "EVE_ENV_FILE_RACE",
      message:
        "The explicit Eve environment file changed while it was being read.",
      source: EVE_ENV_FILE_SOURCE,
    });
  }

  return {
    path,
    dev: before.dev,
    ino: before.ino,
    mode: before.mode,
    size: before.size,
    bytes,
    digest: sha256(bytes),
  };
}

function decodeUtf8(
  bytes: Buffer,
): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.startsWith("\uFEFF") ? text.slice(1) : text;
  } catch {
    throw new EveRuntimeConfigError({
      code: "EVE_ENV_FILE_ENCODING",
      message:
        "The explicit Eve environment file must contain valid UTF-8 text.",
      source: EVE_ENV_FILE_SOURCE,
    });
  }
}

function malformedLine(
  lineNumber: number,
): EveRuntimeConfigError {
  return new EveRuntimeConfigError({
    code: "EVE_ENV_FILE_MALFORMED",
    message:
      `The explicit Eve environment file contains a malformed assignment on line ${lineNumber}.`,
    source: EVE_ENV_FILE_SOURCE,
  });
}

function parseEnvironmentText(
  text: string,
): EveRuntimeValueMap {
  const values = Object.create(null) as Record<string, string>;
  const lines = text.split("\n");
  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    const line = rawLine.endsWith("\r")
      ? rawLine.slice(0, -1)
      : rawLine;
    const firstNonWhitespace = line.search(/\S/u);
    if (firstNonWhitespace === -1 || line[firstNonWhitespace] === "#") {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw malformedLine(lineNumber);
    }
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!EVE_ENVIRONMENT_NAME_PATTERN.test(name)) {
      throw malformedLine(lineNumber);
    }
    if (Object.prototype.hasOwnProperty.call(values, name)) {
      throw new EveRuntimeConfigError({
        code: "EVE_ENV_FILE_DUPLICATE",
        message:
          `The explicit Eve environment file defines ${name} more than once.`,
        source: EVE_ENV_FILE_SOURCE,
        variableName: name,
      });
    }
    if (
      (EVE_RESERVED_HOST_VARIABLES as readonly string[]).includes(name)
    ) {
      throw new EveRuntimeConfigError({
        code: "EVE_ENV_RESERVED_VARIABLE",
        message:
          `The explicit Eve environment file attempts to override reserved host variable ${name}.`,
        source: EVE_ENV_FILE_SOURCE,
        variableName: name,
      });
    }
    values[name] = value;
  }
  return Object.freeze(values);
}

class EveRuntimeRedactionRegistry {
  readonly handle = `eve-runtime-redaction-${randomUUID()}`;
  private readonly values = new Set<string>();

  register(value: string): void {
    if (value.length > 0) this.values.add(value);
  }

  redact(value: string): string {
    let redacted = value;
    const registered = [...this.values].sort(
      (left, right) => right.length - left.length,
    );
    for (const secret of registered) {
      redacted = redacted.split(secret).join("[redacted]");
    }
    return redacted;
  }

  dispose(): void {
    this.values.clear();
  }
}

const activeRedactionRegistries = new Set<EveRuntimeRedactionRegistry>();

export function redactEveRuntimeOutput(value: string): string {
  let redacted = value;
  for (const registry of activeRedactionRegistries) {
    redacted = registry.redact(redacted);
  }
  return redacted;
}

export interface EveStartProcessRequest {
  readonly command: "./node_modules/.bin/eve";
  readonly args: readonly [
    "start",
    "--host",
    "0.0.0.0",
    "--port",
    "8080",
  ];
  readonly cwd: string;
  /**
   * This is a private startup environment. It is intentionally not inherited
   * from the Eden process and never contains the control-plane environment.
   */
  readonly env: Readonly<Record<string, string>>;
}

export interface EveRuntimeProtectedPutRequest {
  readonly targetId: string;
  readonly revision: string;
  readonly inputIdentity: EveRuntimeInputIdentity;
  readonly variableNames: readonly string[];
  readonly values: EveRuntimeValueMap;
}

export interface EveRuntimeProtectedPutResult {
  readonly revision: string;
  readonly handle: string;
}

export interface EveRuntimeProtectedStore {
  /**
   * Implementations must use a provider-protected value channel. This method
   * must not serialize values into argv, URLs, source, records, or logs.
   */
  put(
    request: EveRuntimeProtectedPutRequest,
  ): Promise<EveRuntimeProtectedPutResult>;
}

export type EveRuntimeInjectionMode = "preflight" | "deploy";

export interface EveRuntimeInjection {
  readonly mode: EveRuntimeInjectionMode;
  readonly seam: RedactedRuntimeConfigSeam;
  readonly protectedRevision: string;
  readonly protectedHandle: string | undefined;
  readonly variableNames: readonly string[];
  readonly startCommand: typeof EVE_START_COMMAND;
  runLocal<T>(
    options: {
      readonly cwd: string;
      readonly hostEnvironment: Readonly<Record<string, string>>;
      readonly run: (request: EveStartProcessRequest) => T | Promise<T>;
    },
  ): Promise<T>;
}

export interface EveRuntimeInjectionOptions {
  readonly mode: EveRuntimeInjectionMode;
  readonly targetId?: string;
  readonly protectedStore?: EveRuntimeProtectedStore;
}

export class EveRuntimeConfig {
  private readonly values: EveRuntimeValueMap;
  private readonly observation: EveRuntimeFileObservation;
  private readonly redaction: EveRuntimeRedactionRegistry;
  private disposed = false;
  private readonly safeSeam: RedactedRuntimeConfigSeam;

  private constructor(
    observation: EveRuntimeFileObservation,
    values: EveRuntimeValueMap,
    redaction: EveRuntimeRedactionRegistry,
  ) {
    this.observation = observation;
    this.values = values;
    this.redaction = redaction;
    const variableNames = Object.freeze(Object.keys(values).sort());
    const protectedRevision = `eve-runtime-revision-${randomUUID()}`;
    this.safeSeam = Object.freeze({
      supplied: true,
      inputIdentity: Object.freeze({
        token: `eve-runtime-input-${randomUUID()}`,
        byteLength: observation.bytes.byteLength,
        digest: observation.digest,
      }),
      variableNames,
      reservedHostNames: EVE_RESERVED_HOST_VARIABLES,
      protectedRevision,
      redactionHandle: redaction.handle,
      excludedFromBuildInputs: true,
    });
  }

  static from(
    observation: EveRuntimeFileObservation,
    values: EveRuntimeValueMap,
    redaction: EveRuntimeRedactionRegistry,
  ): EveRuntimeConfig {
    return new EveRuntimeConfig(observation, values, redaction);
  }

  get seam(): RedactedRuntimeConfigSeam {
    return this.safeSeam;
  }

  get inputPath(): string {
    return this.observation.path;
  }

  toJSON(): RedactedRuntimeConfigSeam {
    return this.safeSeam;
  }

  async revalidate(): Promise<void> {
    this.assertUsable();
    const latest = await observeEnvironmentFile(this.observation.path);
    if (!fileObservationMatches(this.observation, latest)) {
      throw new EveRuntimeConfigError({
        code: "EVE_ENV_FILE_RACE",
        message:
          "The explicit Eve environment file changed during Eve validation.",
        source: EVE_ENV_FILE_SOURCE,
      });
    }
  }

  async readInputIdentity(): Promise<EveRuntimeInputIdentity> {
    await this.revalidate();
    return this.safeSeam.inputIdentity;
  }

  withProtectedValues<T>(
    callback: (values: EveRuntimeValueMap) => T,
  ): T {
    this.assertUsable();
    return callback(this.values);
  }

  createStartEnvironment(
    hostEnvironment: Readonly<Record<string, string>>,
  ): Readonly<Record<string, string>> {
    this.assertUsable();
    for (const name of Object.keys(hostEnvironment)) {
      if (
        !(EVE_RESERVED_HOST_VARIABLES as readonly string[]).includes(name)
      ) {
        throw new EveRuntimeConfigError({
          code: "EVE_RUNTIME_INJECTION_INVALID",
          message:
            `The Eve start environment contains a non-host variable ${name}.`,
          variableName: name,
        });
      }
    }
    const environment = {
      ...this.values,
      ...hostEnvironment,
    };
    return Object.freeze(environment);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.redaction.dispose();
    activeRedactionRegistries.delete(this.redaction);
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new EveRuntimeConfigError({
        code: "EVE_RUNTIME_INJECTION_INVALID",
        message: "The Eve runtime configuration has already been released.",
      });
    }
  }
}

export async function readEveRuntimeConfig(
  inputPath: string,
  options: { readonly cwd?: string } = {},
): Promise<EveRuntimeConfig> {
  if (inputPath.length === 0) {
    throw new EveRuntimeConfigError({
      code: "EVE_ENV_FILE_INVALID",
      message: "The explicit Eve environment file path must not be empty.",
    });
  }
  const path = resolve(options.cwd ?? process.cwd(), inputPath);
  const observation = await observeEnvironmentFile(path);
  const values = parseEnvironmentText(
    decodeUtf8(observation.bytes),
  );
  const redaction = new EveRuntimeRedactionRegistry();
  for (const value of Object.values(values)) redaction.register(value);
  activeRedactionRegistries.add(redaction);
  return EveRuntimeConfig.from(observation, values, redaction);
}

export const parseEveRuntimeConfig = readEveRuntimeConfig;
export const loadEveRuntimeConfig = readEveRuntimeConfig;

function validateProtectedPutResult(
  result: unknown,
): void {
  if (
    typeof result !== "object" ||
    result === null ||
    typeof (result as { readonly revision?: unknown }).revision !== "string" ||
    typeof (result as { readonly handle?: unknown }).handle !== "string" ||
    !EVE_RUNTIME_METADATA_PATTERN.test(
      (result as { readonly revision: string }).revision,
    ) ||
    !EVE_RUNTIME_METADATA_PATTERN.test(
      (result as { readonly handle: string }).handle,
    )
  ) {
    throw new EveRuntimeConfigError({
      code: "EVE_RUNTIME_PROTECTED_UPLOAD_FAILED",
      message:
        "The protected Eve runtime store returned an invalid revision handle.",
    });
  }
}

function assertProtectedMetadataDoesNotContainRuntimeValues(
  result: EveRuntimeProtectedPutResult,
): void {
  if (
    redactEveRuntimeOutput(result.revision) !== result.revision ||
    redactEveRuntimeOutput(result.handle) !== result.handle
  ) {
    throw new EveRuntimeConfigError({
      code: "EVE_RUNTIME_PROTECTED_UPLOAD_FAILED",
      message:
        "The protected Eve runtime store returned value-bearing metadata.",
    });
  }
}

function redactRuntimeConfigError(
  error: EveRuntimeConfigError,
): EveRuntimeConfigError {
  return new EveRuntimeConfigError({
    code: error.code,
    message: redactEveRuntimeOutput(error.message),
    ...(error.source === undefined
      ? {}
      : { source: redactEveRuntimeOutput(error.source) }),
    ...(error.variableName === undefined
      ? {}
      : { variableName: redactEveRuntimeOutput(error.variableName) }),
  });
}

export async function prepareEveRuntimeInjection(
  config: EveRuntimeConfig,
  options: EveRuntimeInjectionOptions,
): Promise<EveRuntimeInjection> {
  await config.revalidate();
  const variableNames = config.seam.variableNames;
  if (options.mode === "preflight") {
    if (options.protectedStore !== undefined) {
      throw new EveRuntimeConfigError({
        code: "EVE_RUNTIME_PROTECTED_STORE_UNAVAILABLE",
        message:
          "Preflight runtime configuration must use disposable local injection and cannot use a Cloudflare protected store.",
      });
    }
    return {
      mode: options.mode,
      seam: config.seam,
      protectedRevision: config.seam.protectedRevision,
      protectedHandle: undefined,
      variableNames,
      startCommand: EVE_START_COMMAND,
      async runLocal(runOptions) {
        await config.revalidate();
        const request: EveStartProcessRequest = {
          command: EVE_START_COMMAND[0],
          args: [
            EVE_START_COMMAND[1],
            EVE_START_COMMAND[2],
            EVE_START_COMMAND[3],
            EVE_START_COMMAND[4],
            EVE_START_COMMAND[5],
          ],
          cwd: resolve(runOptions.cwd),
          env: config.createStartEnvironment(runOptions.hostEnvironment),
        };
        return runOptions.run(request);
      },
    };
  }

  if (options.targetId === undefined || options.targetId.length === 0) {
    throw new EveRuntimeConfigError({
      code: "EVE_RUNTIME_INJECTION_INVALID",
      message:
        "Deploy runtime configuration requires an explicit exact target identity.",
    });
  }
  if (options.protectedStore === undefined) {
    throw new EveRuntimeConfigError({
      code: "EVE_RUNTIME_PROTECTED_STORE_UNAVAILABLE",
      message:
        "Deploy runtime configuration requires a protected runtime store.",
    });
  }
  await config.revalidate();
  const revision = config.seam.protectedRevision;
  let stored: EveRuntimeProtectedPutResult;
  try {
    stored = await config.withProtectedValues((values) =>
      options.protectedStore?.put({
        targetId: options.targetId as string,
        revision,
        inputIdentity: config.seam.inputIdentity,
        variableNames,
        values,
      }) as Promise<EveRuntimeProtectedPutResult>
    );
  } catch (error: unknown) {
    if (error instanceof EveRuntimeConfigError) {
      throw redactRuntimeConfigError(error);
    }
    throw new EveRuntimeConfigError({
      code: "EVE_RUNTIME_PROTECTED_UPLOAD_FAILED",
      message:
        "The protected Eve runtime configuration upload failed before publication.",
    });
  }
  validateProtectedPutResult(stored);
  assertProtectedMetadataDoesNotContainRuntimeValues(stored);
  await config.revalidate();
  const protectedRevision = stored.revision;
  return {
    mode: options.mode,
    seam: config.seam,
    protectedRevision,
    protectedHandle: stored.handle,
    variableNames,
    startCommand: EVE_START_COMMAND,
    async runLocal() {
      throw new EveRuntimeConfigError({
        code: "EVE_RUNTIME_LOCAL_INJECTION_UNSUPPORTED",
        message:
          "Deploy runtime values are available only through the protected Container start seam.",
      });
    },
  };
}
