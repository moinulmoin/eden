import type { EdenSessionStorage, EdenSqlStorage } from "./session-journal.js";

export const MAX_RECOVERY_JOBS_PER_ALARM = 4;
export const MAX_RECOVERY_JOBS_PER_INSPECTION_PAGE = 32;
export const MAX_RECOVERY_JOB_ATTEMPTS = 3;
export const RECOVERY_RETRY_DELAY_MS = 1_000;
const MAX_RECOVERY_JOB_ID_BYTES = 256;
const MAX_RECOVERY_JOB_KIND_BYTES = 128;
const MAX_RECOVERY_ACTION_BYTES = 256;
const MAX_RECOVERY_ERROR_BYTES = 512;
const MAX_RECOVERY_TIMESTAMP_BYTES = 64;
const MAX_RECOVERY_INSPECTION_CURSOR_BYTES = 1_024;

export const REGISTERED_RECOVERY_ACTIONS = [
  "mark-complete",
  "always-fail",
  "fail",
  "run-bounded-turn",
] as const;

export type RecoveryAction = (typeof REGISTERED_RECOVERY_ACTIONS)[number];

type SqlRow = Record<string, string | number | null>;

export type RecoveryJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "retryable"
  | "dead";

export interface RecoveryJobInput {
  readonly jobId: string;
  readonly kind: string;
  readonly dueAt: number;
  readonly maxAttempts?: number;
  readonly recoveryAction: string;
  readonly createdAt?: string;
}

export interface RecoveryJobRecord {
  readonly jobId: string;
  readonly kind: string;
  readonly status: RecoveryJobStatus;
  readonly dueAt: number;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastError: string | null;
  readonly recoveryAction: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface RecoveryJobInspection {
  readonly jobs: readonly RecoveryJobRecord[];
  readonly nextDueAt: number | null;
  readonly nextCursor: string | null;
}

export interface RecoveryJobInspectionOptions {
  readonly cursor?: string;
  readonly limit?: number;
}

export type RecoveryJobEnqueueResult =
  | {
      readonly status: "scheduled";
      readonly job: RecoveryJobRecord;
    }
  | {
      readonly status: "deduplicated";
      readonly job: RecoveryJobRecord;
    };

export type RecoveryJobRecoveryResult = {
  readonly status: "scheduled";
  readonly job: RecoveryJobRecord;
};

export type RecoveryJobStorage = EdenSessionStorage;

export interface RecoveryJobExecutionOptions {
  readonly now?: number;
  readonly limit?: number;
}

export interface RecoveryJobProcessingResult {
  readonly processed: number;
  readonly completed: number;
  readonly retryable: number;
  readonly dead: number;
}

interface RecoveryJobRow extends SqlRow {
  readonly job_id: string;
  readonly session_id: string;
  readonly kind: string;
  readonly status: RecoveryJobStatus;
  readonly due_at: number;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly last_error: string | null;
  readonly recovery_action: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertBoundedText(value: string, label: string, maxBytes: number): void {
  if (value.length === 0 || bytes(value) > maxBytes) {
    throw new Error(`${label} is invalid`);
  }
}

function assertJobId(jobId: string): void {
  assertBoundedText(jobId, "Recovery job identity", MAX_RECOVERY_JOB_ID_BYTES);
}

export function isRegisteredRecoveryAction(
  action: string | null | undefined,
): action is RecoveryAction {
  return (
    typeof action === "string" &&
    (REGISTERED_RECOVERY_ACTIONS as readonly string[]).includes(action)
  );
}

function assertRecoveryAction(action: string | null | undefined): asserts action is RecoveryAction {
  if (!isRegisteredRecoveryAction(action)) {
    throw new Error("Unknown recovery action");
  }
}

function assertJobInput(input: RecoveryJobInput): void {
  assertJobId(input.jobId);
  assertBoundedText(input.kind, "Recovery job kind", MAX_RECOVERY_JOB_KIND_BYTES);
  assertBoundedText(
    input.recoveryAction,
    "Recovery action",
    MAX_RECOVERY_ACTION_BYTES,
  );
  if (!Number.isSafeInteger(input.dueAt) || input.dueAt < 0) {
    throw new Error("Recovery job due time is invalid");
  }
  const maxAttempts = input.maxAttempts ?? MAX_RECOVERY_JOB_ATTEMPTS;
  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > MAX_RECOVERY_JOB_ATTEMPTS
  ) {
    throw new Error("Recovery job attempt bound is invalid");
  }
  if (input.createdAt !== undefined) {
    assertBoundedText(
      input.createdAt,
      "Recovery job creation time",
      MAX_RECOVERY_TIMESTAMP_BYTES,
    );
  }
  assertRecoveryAction(input.recoveryAction);
}

function nowIso(now = Date.now()): string {
  return new Date(now).toISOString();
}

function readJob(
  sql: EdenSqlStorage,
  sessionId: string,
  jobId: string,
): RecoveryJobRecord | null {
  const row = sql
    .exec<RecoveryJobRow>(
      `SELECT job_id, session_id, kind, status, due_at, attempts,
        max_attempts, last_error, recovery_action, created_at, updated_at,
        completed_at
       FROM jobs
       WHERE session_id = ? AND job_id = ?`,
      sessionId,
      jobId,
    )
    .toArray()[0];
  return row === undefined ? null : mapJob(row);
}

function mapJob(row: RecoveryJobRow): RecoveryJobRecord {
  return {
    jobId: row.job_id,
    kind: row.kind,
    status: row.status,
    dueAt: row.due_at,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    recoveryAction: row.recovery_action,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function readDueJob(
  sql: EdenSqlStorage,
  sessionId: string,
  now: number,
  excludedJobIds: ReadonlySet<string>,
): RecoveryJobRecord | null {
  const exclusion = Array.from(excludedJobIds);
  const exclusionClause =
    exclusion.length === 0
      ? ""
      : ` AND job_id NOT IN (${exclusion.map(() => "?").join(", ")})`;
  const row = sql
    .exec<RecoveryJobRow>(
      `SELECT job_id, session_id, kind, status, due_at, attempts,
        max_attempts, last_error, recovery_action, created_at, updated_at,
        completed_at
       FROM jobs
       WHERE session_id = ?
         AND status IN ('pending', 'retryable', 'running')
         AND due_at <= ?${exclusionClause}
       ORDER BY due_at ASC, job_id ASC
       LIMIT 1`,
      sessionId,
      now,
      ...exclusion,
    )
    .toArray()[0];
  return row === undefined ? null : mapJob(row);
}

function readNextDueAt(
  sql: EdenSqlStorage,
  sessionId: string,
): number | null {
  const row = sql
    .exec<{ due_at: number | null }>(
      `SELECT MIN(due_at) AS due_at
       FROM jobs
       WHERE session_id = ?
         AND status IN ('pending', 'retryable', 'running')`,
      sessionId,
    )
    .toArray()[0];
  return row?.due_at ?? null;
}

interface RecoveryJobInspectionCursor {
  readonly version: 1;
  readonly dueAt: number;
  readonly jobId: string;
}

function encodeInspectionCursor(job: RecoveryJobRecord): string {
  const payload: RecoveryJobInspectionCursor = {
    version: 1,
    dueAt: job.dueAt,
    jobId: job.jobId,
  };
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const byte of encoded) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function decodeInspectionCursor(cursor: string): RecoveryJobInspectionCursor {
  if (cursor.length === 0 || bytes(cursor) > MAX_RECOVERY_INSPECTION_CURSOR_BYTES) {
    throw new Error("Recovery inspection cursor is invalid");
  }
  try {
    const padded = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const padding = padded.length % 4;
    const binary = atob(padded + (padding === 0 ? "" : "=".repeat(4 - padding)));
    const encoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(encoded));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as { readonly version?: unknown }).version !== 1 ||
      !Number.isSafeInteger((parsed as { readonly dueAt?: unknown }).dueAt) ||
      (parsed as { readonly dueAt: number }).dueAt < 0 ||
      typeof (parsed as { readonly jobId?: unknown }).jobId !== "string"
    ) {
      throw new Error("Recovery inspection cursor is invalid");
    }
    assertJobId((parsed as { readonly jobId: string }).jobId);
    return parsed as RecoveryJobInspectionCursor;
  } catch {
    throw new Error("Recovery inspection cursor is invalid");
  }
}

function readInspectionPage(
  sql: EdenSqlStorage,
  sessionId: string,
  options: RecoveryJobInspectionOptions,
): {
  readonly jobs: readonly RecoveryJobRecord[];
  readonly nextCursor: string | null;
} {
  const requestedLimit = options.limit ?? MAX_RECOVERY_JOBS_PER_INSPECTION_PAGE;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    throw new Error("Recovery inspection page limit is invalid");
  }
  const limit = Math.min(requestedLimit, MAX_RECOVERY_JOBS_PER_INSPECTION_PAGE);
  const cursor =
    options.cursor === undefined
      ? null
      : decodeInspectionCursor(options.cursor);
  const rows = cursor === null
    ? sql.exec<RecoveryJobRow>(
      `SELECT job_id, session_id, kind, status, due_at, attempts,
        max_attempts, last_error, recovery_action, created_at, updated_at,
        completed_at
       FROM jobs
       WHERE session_id = ?
       ORDER BY due_at ASC, job_id ASC
       LIMIT ?`,
      sessionId,
      limit + 1,
    ).toArray()
    : sql.exec<RecoveryJobRow>(
      `SELECT job_id, session_id, kind, status, due_at, attempts,
        max_attempts, last_error, recovery_action, created_at, updated_at,
        completed_at
       FROM jobs
       WHERE session_id = ?
         AND (due_at > ? OR (due_at = ? AND job_id > ?))
       ORDER BY due_at ASC, job_id ASC
       LIMIT ?`,
      sessionId,
      cursor.dueAt,
      cursor.dueAt,
      cursor.jobId,
      limit + 1,
    ).toArray();
  const jobs = rows.slice(0, limit).map(mapJob);
  const lastJob = jobs[jobs.length - 1];
  return {
    jobs,
    nextCursor:
      rows.length > limit && lastJob !== undefined
        ? encodeInspectionCursor(lastJob)
        : null,
  };
}

function requireSession(sql: EdenSqlStorage, sessionId: string): void {
  const row = sql
    .exec<{ present: number }>(
      "SELECT EXISTS (SELECT 1 FROM session_meta WHERE session_id = ?) AS present",
      sessionId,
    )
    .toArray()[0];
  if (row?.present !== 1) {
    throw new Error("Recovery job session is not initialized");
  }
}

function sanitizeText(value: string): string {
  const compact = value
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (
    /authorization|bearer|binding|cookie|credential|password|secret|token|api[-_ ]?key/iu.test(
      compact,
    )
  ) {
    return "Recovery job failed with a redacted error";
  }
  const encoded = new TextEncoder().encode(compact);
  if (encoded.byteLength <= MAX_RECOVERY_ERROR_BYTES) return compact;
  return new TextDecoder().decode(encoded.slice(0, MAX_RECOVERY_ERROR_BYTES));
}

export function sanitizeRecoveryError(error: unknown): string {
  const candidate =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Recovery job failed";
  const sanitized = sanitizeText(candidate);
  return sanitized.length > 0 ? sanitized : "Recovery job failed";
}

function errorId(jobId: string): string {
  return `err_job_${jobId}`;
}

function upsertJobError(
  sql: EdenSqlStorage,
  sessionId: string,
  job: RecoveryJobRecord,
  summary: string,
  timestamp: string,
): void {
  sql.exec(
    `INSERT INTO errors (
      error_id, session_id, turn_id, step_id, code, message, retryable,
      status, created_at, resolved_at
    ) VALUES (?, ?, NULL, NULL, ?, ?, ?, 'open', ?, NULL)
    ON CONFLICT(error_id) DO UPDATE SET
      code = excluded.code,
      message = excluded.message,
      retryable = excluded.retryable,
      status = 'open',
      resolved_at = NULL`,
    errorId(job.jobId),
    sessionId,
    "recovery_job_failed",
    summary,
    job.attempts < job.maxAttempts ? 1 : 0,
    timestamp,
  );
}

function resolveJobError(
  sql: EdenSqlStorage,
  sessionId: string,
  jobId: string,
  timestamp: string,
): void {
  sql.exec(
    `UPDATE errors
     SET status = 'resolved', resolved_at = ?
     WHERE session_id = ? AND error_id = ?`,
    timestamp,
    sessionId,
    errorId(jobId),
  );
}

function claimJob(
  storage: RecoveryJobStorage,
  sessionId: string,
  now: number,
  excludedJobIds: ReadonlySet<string>,
): RecoveryJobRecord | null {
  return storage.transactionSync(() => {
    const candidate = readDueJob(
      storage.sql,
      sessionId,
      now,
      excludedJobIds,
    );
    if (candidate === null) return null;

    const timestamp = nowIso(now);
    if (candidate.attempts >= candidate.maxAttempts) {
      const summary = isRegisteredRecoveryAction(candidate.recoveryAction)
        ? sanitizeRecoveryError(
            candidate.lastError ?? "Recovery job retry limit reached",
          )
        : "Unknown recovery action";
      storage.sql.exec(
        `UPDATE jobs
         SET status = 'dead', last_error = ?,
             updated_at = ?
         WHERE session_id = ? AND job_id = ?
           AND status IN ('pending', 'retryable', 'running')`,
        summary,
        timestamp,
        sessionId,
        candidate.jobId,
      );
      upsertJobError(
        storage.sql,
        sessionId,
        { ...candidate, status: "dead", lastError: summary },
        summary,
        timestamp,
      );
      return readJob(storage.sql, sessionId, candidate.jobId);
    }

    storage.sql.exec(
      `UPDATE jobs
       SET status = 'running', attempts = attempts + 1, updated_at = ?
       WHERE session_id = ? AND job_id = ?
         AND status IN ('pending', 'retryable', 'running')
         AND due_at <= ?`,
      timestamp,
      sessionId,
      candidate.jobId,
      now,
    );
    return readJob(storage.sql, sessionId, candidate.jobId);
  });
}

function completeJob(
  storage: RecoveryJobStorage,
  sessionId: string,
  job: RecoveryJobRecord,
  now: number,
): void {
  storage.transactionSync(() => {
    const timestamp = nowIso(now);
    storage.sql.exec(
      `UPDATE jobs
       SET status = 'completed', last_error = NULL, updated_at = ?,
           completed_at = ?
       WHERE session_id = ? AND job_id = ? AND status = 'running'
         AND attempts = ?`,
      timestamp,
      timestamp,
      sessionId,
      job.jobId,
      job.attempts,
    );
    resolveJobError(storage.sql, sessionId, job.jobId, timestamp);
  });
}

function failJob(
  storage: RecoveryJobStorage,
  sessionId: string,
  job: RecoveryJobRecord,
  error: unknown,
  now: number,
): RecoveryJobStatus {
  return storage.transactionSync(() => {
    const timestamp = nowIso(now);
    const summary = sanitizeRecoveryError(error);
    const status: RecoveryJobStatus =
      job.attempts >= job.maxAttempts ? "dead" : "retryable";
    storage.sql.exec(
      `UPDATE jobs
       SET status = ?, due_at = ?, last_error = ?, updated_at = ?,
           completed_at = NULL
       WHERE session_id = ? AND job_id = ? AND status = 'running'
         AND attempts = ?`,
      status,
      now + RECOVERY_RETRY_DELAY_MS,
      summary,
      timestamp,
      sessionId,
      job.jobId,
      job.attempts,
    );
    upsertJobError(
      storage.sql,
      sessionId,
      { ...job, status, lastError: summary },
      summary,
      timestamp,
    );
    return status;
  });
}

export function inspectRecoveryJobs(
  sql: EdenSqlStorage,
  sessionId: string,
  options: RecoveryJobInspectionOptions = {},
): RecoveryJobInspection {
  requireSession(sql, sessionId);
  const page = readInspectionPage(sql, sessionId, options);
  return {
    jobs: page.jobs,
    nextDueAt: readNextDueAt(sql, sessionId),
    nextCursor: page.nextCursor,
  };
}

export function enqueueRecoveryJob(
  storage: RecoveryJobStorage,
  sessionId: string,
  input: RecoveryJobInput,
): RecoveryJobEnqueueResult {
  assertJobInput(input);
  requireSession(storage.sql, sessionId);

  return storage.transactionSync(() => {
    const existing = readJob(storage.sql, sessionId, input.jobId);
    const maxAttempts = input.maxAttempts ?? MAX_RECOVERY_JOB_ATTEMPTS;
    if (existing !== null) {
      if (
        existing.kind !== input.kind ||
        existing.maxAttempts !== maxAttempts ||
        existing.recoveryAction !== input.recoveryAction
      ) {
        throw new Error("Recovery job identity conflicts with durable state");
      }
      return { status: "deduplicated", job: existing };
    }

    const timestamp = input.createdAt ?? nowIso();
    storage.sql.exec(
      `INSERT INTO jobs (
        job_id, session_id, kind, status, due_at, attempts, max_attempts,
        last_error, recovery_action, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, 'pending', ?, 0, ?, NULL, ?, ?, ?, NULL)`,
      input.jobId,
      sessionId,
      input.kind,
      input.dueAt,
      maxAttempts,
      input.recoveryAction,
      timestamp,
      timestamp,
    );
    const job = readJob(storage.sql, sessionId, input.jobId);
    if (job === null) throw new Error("Recovery job was not persisted");
    return { status: "scheduled", job };
  });
}

export function recoverRecoveryJob(
  storage: RecoveryJobStorage,
  sessionId: string,
  jobId: string,
  recoveryAction?: string,
  dueAt = Date.now() + RECOVERY_RETRY_DELAY_MS,
): RecoveryJobRecoveryResult {
  assertJobId(jobId);
  if (
    !Number.isSafeInteger(dueAt) ||
    dueAt < 0 ||
    (recoveryAction !== undefined &&
      (recoveryAction.length === 0 ||
        bytes(recoveryAction) > MAX_RECOVERY_ACTION_BYTES))
  ) {
    throw new Error("Recovery operation is invalid");
  }
  requireSession(storage.sql, sessionId);

  return storage.transactionSync(() => {
    const existing = readJob(storage.sql, sessionId, jobId);
    if (existing === null) throw new Error("Recovery job was not found");
    const action = recoveryAction ?? existing.recoveryAction;
    if (action === null) throw new Error("Recovery action is required");
    assertRecoveryAction(action);
    storage.sql.exec(
      `UPDATE jobs
       SET status = 'pending', due_at = ?, attempts = 0, last_error = NULL,
           recovery_action = ?, updated_at = ?, completed_at = NULL
       WHERE session_id = ? AND job_id = ? AND status = 'dead'`,
      dueAt,
      action,
      nowIso(),
      sessionId,
      jobId,
    );
    const job = readJob(storage.sql, sessionId, jobId);
    if (job === null || job.status !== "pending") {
      throw new Error("Recovery job is not eligible for recovery");
    }
    return { status: "scheduled", job };
  });
}

export async function processRecoveryJobs(
  storage: RecoveryJobStorage,
  sessionId: string,
  execute: (job: RecoveryJobRecord) => void | Promise<void>,
  options: RecoveryJobExecutionOptions = {},
): Promise<RecoveryJobProcessingResult> {
  const now = options.now ?? Date.now();
  const requestedLimit = options.limit ?? MAX_RECOVERY_JOBS_PER_ALARM;
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("Recovery job clock value is invalid");
  }
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    throw new Error("Recovery job batch limit is invalid");
  }
  const limit = Math.min(requestedLimit, MAX_RECOVERY_JOBS_PER_ALARM);
  requireSession(storage.sql, sessionId);

  let processed = 0;
  let completed = 0;
  let retryable = 0;
  let dead = 0;
  const processedJobIds = new Set<string>();

  while (processed < limit) {
    const job = claimJob(storage, sessionId, now, processedJobIds);
    if (job === null) break;
    processedJobIds.add(job.jobId);
    if (job.status === "dead") {
      dead += 1;
      processed += 1;
      continue;
    }

    processed += 1;
    try {
      assertRecoveryAction(job.recoveryAction);
      await execute(job);
      completeJob(storage, sessionId, job, now);
      completed += 1;
    } catch (error) {
      const status = failJob(storage, sessionId, job, error, now);
      if (status === "dead") dead += 1;
      else retryable += 1;
    }
  }

  return { processed, completed, retryable, dead };
}

export function nextRecoveryJobDueAt(
  sql: EdenSqlStorage,
  sessionId: string,
): number | null {
  requireSession(sql, sessionId);
  return readNextDueAt(sql, sessionId);
}
