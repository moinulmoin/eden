import type { EdenEvent } from "../../packages/definitions/src/index.js";

// @ts-expect-error A session.started envelope must carry session.started data.
const sessionWithWaitingData: EdenEvent = {
  streamIndex: 1,
  eventId: "evt_invalid_session",
  type: "session.started",
  data: { status: "waiting" },
  committedAt: "2026-08-10T00:00:00.000Z",
};

const completedWithTurnData: EdenEvent = {
  streamIndex: 2,
  eventId: "evt_invalid_message",
  type: "message.completed",
  // @ts-expect-error A message.completed envelope must carry message.completed data.
  data: { turnId: "turn_123" },
  committedAt: "2026-08-10T00:00:00.000Z",
};

const waitingWithFailureData: EdenEvent = {
  streamIndex: 3,
  eventId: "evt_invalid_waiting",
  type: "session.waiting",
  data: {
    // @ts-expect-error A session.waiting envelope must carry session.waiting data.
    code: "unexpected",
    message: "wrong payload",
    retryable: false,
  },
  committedAt: "2026-08-10T00:00:00.000Z",
};

void sessionWithWaitingData;
void completedWithTurnData;
void waitingWithFailureData;
