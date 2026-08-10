import type {
  EdenCommandRequest,
  EdenEvent,
  EdenEventType,
  EdenSessionAcceptance,
  EdenSessionSnapshot,
} from "@eden/definitions";

export type {
  EdenCommandRequest,
  EdenEvent,
  EdenEventDataByType,
  EdenEventType,
  EdenSessionAcceptance,
  EdenSessionSnapshot,
} from "@eden/definitions";

export interface EdenClientOptions {
  readonly baseUrl: string;
  readonly bearerToken: string;
}

export interface EdenClientState {
  readonly sessionId: string;
  readonly streamIndex: number;
}

export interface EdenEventStore {
  load(): Promise<EdenClientState | undefined>;
  save(state: EdenClientState): Promise<void>;
}

export interface EdenClient {
  createSession(): Promise<EdenSessionSnapshot>;
  sendMessage(
    sessionId: string,
    request: EdenCommandRequest,
  ): Promise<EdenSessionAcceptance>;
  events(
    sessionId: string,
    startIndex?: number,
  ): AsyncIterable<EdenEvent<EdenEventType>>;
}

export type { EdenClientOptions as EdenClientConfiguration };
