import type {
  EdenEvent,
  EdenEventDataByType,
  EdenEventType,
  EdenVersionSet,
} from "../../packages/definitions/src/index.js";

const versions: EdenVersionSet = {
  runtime: "eden-runtime-1",
  agentBundle: "eden-agent-bundle-1",
  manifest: "eden-manifest-1",
  protocol: "eden-protocol-1",
  schema: 1,
};

const sessionStarted: EdenEvent<"session.started"> = {
  streamIndex: 1,
  eventId: "evt_session",
  type: "session.started",
  data: {
    sessionId: "sess_123",
    status: "new",
    versions,
  },
  committedAt: "2026-08-10T00:00:00.000Z",
};

const waiting: EdenEvent = {
  streamIndex: 2,
  eventId: "evt_waiting",
  type: "session.waiting",
  data: { status: "waiting" },
  committedAt: "2026-08-10T00:00:00.000Z",
};

function readEvent(event: EdenEvent): string {
  switch (event.type) {
    case "session.started":
      return event.data.sessionId;
    case "turn.started":
      return event.data.turnId;
    case "message.received":
      return event.data.messageId;
    case "step.started":
    case "step.completed":
      return event.data.stepId;
    case "actions.requested":
      return event.data.actions[0]?.callId ?? "no-actions";
    case "action.result":
      return event.data.callId;
    case "message.completed":
      return event.data.content;
    case "turn.completed":
      return event.data.turnId;
    case "session.waiting":
      return event.data.status;
    case "step.failed":
      return event.data.stepId;
    case "turn.failed":
      return event.data.turnId;
    case "session.failed":
      return event.data.code;
  }
}

function readDataByType<TType extends EdenEventType>(
  event: EdenEvent<TType>,
): EdenEventDataByType[TType] {
  return event.data;
}

void sessionStarted;
void waiting;
void readEvent;
void readDataByType;
