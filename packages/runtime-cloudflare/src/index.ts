import type {
  EdenEvent,
  EdenEventType,
  EdenSessionSnapshot,
  EdenVersionSet,
} from "@eden/definitions";

export type {
  EdenEvent,
  EdenEventDataByType,
  EdenEventType,
  EdenSessionSnapshot,
  EdenVersionSet,
} from "@eden/definitions";

export {
  createOpaqueSessionId,
  createSessionObjectName,
  isOpaqueSessionId,
  sessionIdFromObjectName,
} from "./session-identity.js";
export {
  SESSION_SCHEMA_MIGRATIONS,
  SESSION_SCHEMA_TABLES,
  SESSION_SCHEMA_VERSION,
} from "./session-schema.js";
export type { SessionMigration } from "./session-schema.js";

export interface EdenRuntimeConfiguration {
  readonly versions: EdenVersionSet;
}

export interface EdenSessionStore {
  createSession(): Promise<EdenSessionSnapshot>;
  readEvents(
    sessionId: string,
    startIndex?: number,
  ): Promise<readonly EdenEvent<EdenEventType>[]>;
}

export interface EdenRuntime {
  readonly configuration: EdenRuntimeConfiguration;
  readonly sessions: EdenSessionStore;
}

export function createRuntime(
  configuration: EdenRuntimeConfiguration,
  sessions: EdenSessionStore,
): EdenRuntime {
  return { configuration, sessions };
}
