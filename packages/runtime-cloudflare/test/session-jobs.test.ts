import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, test } from "vitest";

import { EdenSession } from "../src/session.js";
import {
  MAX_RECOVERY_JOBS_PER_ALARM,
  MAX_RECOVERY_JOBS_PER_INSPECTION_PAGE,
  type RecoveryJobInput,
} from "../src/session-jobs.js";
import { EDEN_VERSIONS } from "@moinulmoin/eden-definitions";
import {
  createOpaqueSessionId,
  createSessionObjectName,
} from "../src/session-identity.js";
import { SESSION_SCHEMA_VERSION } from "../src/session-schema.js";
import { readSessionRehydratedState } from "../src/session-state.js";

function sessionStub(sessionId: string): DurableObjectStub {
  return env.EDEN_SESSIONS.getByName(createSessionObjectName(sessionId));
}

async function initializeSession(
  stub: DurableObjectStub,
  sessionId: string,
  versions = EDEN_VERSIONS,
): Promise<void> {
  const response = await stub.fetch("https://session/_eden/initialize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId,
      ownerPrincipal: "principal:test",
      versions,
    }),
  });
  expect(response.status).toBe(201);
  await response.arrayBuffer();
}

async function enqueue(
  stub: DurableObjectStub,
  input: Omit<RecoveryJobInput, "dueAt"> & { dueAt?: number },
): Promise<unknown> {
  return runInDurableObject(stub, (instance) =>
    (instance as EdenSession).enqueueRecoveryJob({
      ...input,
      dueAt: input.dueAt ?? Date.now() + 60_000,
    }),
  );
}

async function runAlarm(
  stub: DurableObjectStub,
  dueJobIds: readonly string[],
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    for (const jobId of dueJobIds) {
      state.storage.sql.exec(
        "UPDATE jobs SET due_at = ? WHERE job_id = ?",
        Date.now() - 1,
        jobId,
      );
    }
    await state.storage.setAlarm(Date.now() + 60_000);
  });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
}

async function inspect(stub: DurableObjectStub): Promise<{
  readonly jobs: readonly {
    readonly jobId: string;
    readonly status: string;
    readonly attempts: number;
    readonly lastError: string | null;
    readonly recoveryAction: string | null;
  }[];
  readonly nextDueAt: number | null;
}> {
  return runInDurableObject(stub, (instance) =>
    (instance as EdenSession).inspectRecoveryJobs(),
  );
}

describe("EdenSession recovery jobs and alarms", () => {
  test("returns bounded resumable inspection pages for complete job histories", async () => {
    const sessionId = createOpaqueSessionId();
    const stub = sessionStub(sessionId);
    await initializeSession(stub, sessionId);

    const totalJobs = MAX_RECOVERY_JOBS_PER_INSPECTION_PAGE * 2 + 3;
    for (let index = 0; index < totalJobs; index += 1) {
      await enqueue(stub, {
        jobId: `job_page_${String(index).padStart(3, "0")}`,
        kind: "checkpoint",
        recoveryAction: "mark-complete",
        dueAt: 1_000,
      });
    }

    const seen = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await runInDurableObject(stub, (instance) =>
        (instance as EdenSession).inspectRecoveryJobs({
          cursor,
          limit: 3,
        }),
      );
      pages += 1;
      expect(page.jobs.length).toBeLessThanOrEqual(3);
      expect(page.jobs.length).toBeLessThanOrEqual(
        MAX_RECOVERY_JOBS_PER_INSPECTION_PAGE,
      );
      for (const job of page.jobs) {
        expect(seen.has(job.jobId)).toBe(false);
        seen.add(job.jobId);
      }
      if (page.nextCursor === null) {
        cursor = undefined;
      } else {
        expect(page.nextCursor.length).toBeGreaterThan(0);
        expect(page.nextCursor).not.toBe(page.jobs.at(-1)?.jobId);
        expect(cursors.has(page.nextCursor)).toBe(false);
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
    } while (cursor !== undefined);

    expect(pages).toBeGreaterThan(1);
    expect(seen).toHaveLength(totalJobs);
  }, 15_000);

  test("rejects unknown actions and durably dead-letters legacy unknown jobs", async () => {
    const sessionId = createOpaqueSessionId();
    const stub = sessionStub(sessionId);
    await initializeSession(stub, sessionId);

    await expect(
      enqueue(stub, {
        jobId: "job_unknown_enqueue",
        kind: "checkpoint",
        recoveryAction: "not-registered",
      }),
    ).rejects.toThrow(/unknown recovery action/i);

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO jobs (
          job_id, session_id, kind, status, due_at, attempts, max_attempts,
          last_error, recovery_action, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, 'pending', ?, 0, 3, NULL, ?, ?, ?, NULL)`,
        "job_unknown_legacy",
        sessionId,
        "checkpoint",
        Date.now() - 1,
        "not-registered",
        new Date().toISOString(),
        new Date().toISOString(),
      );
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await runAlarm(stub, ["job_unknown_legacy"]);
    }

    const dead = await inspect(stub);
    expect(dead.jobs).toEqual([
      expect.objectContaining({
        jobId: "job_unknown_legacy",
        status: "dead",
        attempts: 3,
        recoveryAction: "not-registered",
        lastError: "Unknown recovery action",
      }),
    ]);
    const durableError = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{
          readonly code: string;
          readonly message: string;
          readonly retryable: number;
          readonly status: string;
        }>(
          "SELECT code, message, retryable, status FROM errors WHERE error_id = ?",
          "err_job_job_unknown_legacy",
        )
        .toArray(),
    );
    expect(durableError).toEqual([
      {
        code: "recovery_job_failed",
        message: "Unknown recovery action",
        retryable: 0,
        status: "open",
      },
    ]);

    await expect(
      runInDurableObject(stub, (instance) =>
        (instance as EdenSession).recoverRecoveryJob("job_unknown_legacy"),
      ),
    ).rejects.toThrow(/unknown recovery action/i);

    await runInDurableObject(stub, (instance) =>
      (instance as EdenSession).recoverRecoveryJob("job_unknown_legacy", {
        recoveryAction: "mark-complete",
        dueAt: Date.now() + 60_000,
      }),
    );
    await runAlarm(stub, ["job_unknown_legacy"]);
    expect((await inspect(stub)).jobs[0]).toMatchObject({
      status: "completed",
      attempts: 1,
      recoveryAction: "mark-complete",
    });
  }, 15_000);

  test("deduplicates stable jobs, bounds one alarm batch, and rearms the next due job", async () => {
    const sessionId = createOpaqueSessionId();
    const stub = sessionStub(sessionId);
    await initializeSession(stub, sessionId);

    const common = {
      kind: "checkpoint",
      recoveryAction: "mark-complete",
      maxAttempts: 3,
    } as const;
    const first = await enqueue(stub, {
      ...common,
      jobId: "job_01",
    });
    const duplicate = await enqueue(stub, {
      ...common,
      jobId: "job_01",
    });
    expect(first).toMatchObject({ status: "scheduled" });
    expect(duplicate).toMatchObject({ status: "deduplicated" });

    await expect(
      enqueue(stub, {
        ...common,
        jobId: "job_01",
        recoveryAction: "always-fail",
      }),
    ).rejects.toThrow(/identity/i);

    for (let index = 2; index <= MAX_RECOVERY_JOBS_PER_ALARM + 1; index += 1) {
      await enqueue(stub, {
        ...common,
        jobId: `job_${String(index).padStart(2, "0")}`,
      });
    }

    const scheduled = await inspect(stub);
    expect(scheduled.jobs).toHaveLength(MAX_RECOVERY_JOBS_PER_ALARM + 1);
    expect(scheduled.nextDueAt).not.toBeNull();

    await runAlarm(stub, ["job_01", "job_02", "job_03", "job_04"]);
    const afterFirstAlarm = await inspect(stub);
    expect(
      afterFirstAlarm.jobs.filter(({ status }) => status === "completed"),
    ).toHaveLength(MAX_RECOVERY_JOBS_PER_ALARM);
    expect(
      afterFirstAlarm.jobs.filter(({ status }) => status === "pending"),
    ).toHaveLength(1);
    expect(afterFirstAlarm.nextDueAt).not.toBeNull();

    await runAlarm(stub, ["job_05"]);
    const afterSecondAlarm = await inspect(stub);
    expect(afterSecondAlarm.jobs.every(({ status }) => status === "completed")).toBe(
      true,
    );
    expect(afterSecondAlarm.jobs.every(({ attempts }) => attempts === 1)).toBe(true);
    expect(afterSecondAlarm.nextDueAt).toBeNull();
  }, 15_000);

  test("retains bounded attempts and sanitized failure metadata with an explicit recovery path", async () => {
    const sessionId = createOpaqueSessionId();
    const stub = sessionStub(sessionId);
    await initializeSession(stub, sessionId);

    await enqueue(stub, {
      jobId: "job_failing",
      kind: "checkpoint",
      recoveryAction: "always-fail",
      maxAttempts: 3,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await runAlarm(stub, ["job_failing"]);
    }

    const failed = await inspect(stub);
    expect(failed.jobs).toEqual([
      expect.objectContaining({
        jobId: "job_failing",
        status: "dead",
        attempts: 3,
        recoveryAction: "always-fail",
      }),
    ]);
    expect(failed.jobs[0]?.lastError).toBeTruthy();
    expect(failed.jobs[0]?.lastError).not.toContain("sentinel-secret");
    expect(failed.nextDueAt).toBeNull();
    const durableError = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{
          readonly code: string;
          readonly message: string;
          readonly retryable: number;
          readonly status: string;
        }>(
          "SELECT code, message, retryable, status FROM errors WHERE error_id = ?",
          "err_job_job_failing",
        )
        .toArray(),
    );
    expect(durableError).toEqual([
      {
        code: "recovery_job_failed",
        message: "Configured recovery action failed",
        retryable: 0,
        status: "open",
      },
    ]);

    const recovered = await runInDurableObject(stub, (instance) =>
      (instance as EdenSession).recoverRecoveryJob("job_failing", {
        recoveryAction: "mark-complete",
        dueAt: Date.now() + 60_000,
      }),
    );
    expect(recovered).toMatchObject({ status: "scheduled" });
    await runAlarm(stub, ["job_failing"]);

    const afterRecovery = await inspect(stub);
    expect(afterRecovery.jobs).toEqual([
      expect.objectContaining({
        jobId: "job_failing",
        status: "completed",
        attempts: 1,
        recoveryAction: "mark-complete",
        lastError: null,
      }),
    ]);
  }, 15_000);

  test("keeps queued work local to each session", async () => {
    const firstSessionId = createOpaqueSessionId();
    const secondSessionId = createOpaqueSessionId();
    const firstStub = sessionStub(firstSessionId);
    const secondStub = sessionStub(secondSessionId);
    await initializeSession(firstStub, firstSessionId);
    await initializeSession(secondStub, secondSessionId);

    const input = {
      jobId: "job_same_identity",
      kind: "checkpoint",
      recoveryAction: "mark-complete",
      maxAttempts: 3,
    } as const;
    expect(await enqueue(firstStub, input)).toMatchObject({ status: "scheduled" });
    expect(
      await enqueue(secondStub, {
        ...input,
        jobId: "job_other_session",
      }),
    ).toMatchObject({ status: "scheduled" });

    await runAlarm(firstStub, [input.jobId]);
    await runAlarm(secondStub, ["job_other_session"]);

    expect((await inspect(firstStub)).jobs[0]?.status).toBe("completed");
    expect((await inspect(secondStub)).jobs[0]?.status).toBe("completed");
  }, 15_000);

  test("exposes bounded inspect and recovery operations through the internal session surface", async () => {
    const sessionId = createOpaqueSessionId();
    const stub = sessionStub(sessionId);
    await initializeSession(stub, sessionId);

    const enqueueResponse = await stub.fetch("https://session/_eden/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jobId: "job_endpoint",
        kind: "checkpoint",
        dueAt: Date.now() + 60_000,
        recoveryAction: "mark-complete",
        maxAttempts: 3,
      }),
    });
    expect(enqueueResponse.status).toBe(201);
    expect(await enqueueResponse.json()).toMatchObject({
      status: "scheduled",
      job: {
        jobId: "job_endpoint",
        recoveryAction: "mark-complete",
        status: "pending",
      },
    });

    const inspectResponse = await stub.fetch("https://session/_eden/jobs");
    expect(inspectResponse.status).toBe(200);
    expect(await inspectResponse.json()).toMatchObject({
      jobs: [
        expect.objectContaining({
          jobId: "job_endpoint",
          recoveryAction: "mark-complete",
        }),
      ],
      nextCursor: null,
    });
  }, 15_000);

  test("paginates the internal inspection endpoint with an opaque cursor", async () => {
    const sessionId = createOpaqueSessionId();
    const stub = sessionStub(sessionId);
    await initializeSession(stub, sessionId);

    for (let index = 0; index < 5; index += 1) {
      await enqueue(stub, {
        jobId: `job_endpoint_page_${index}`,
        kind: "checkpoint",
        recoveryAction: "mark-complete",
        dueAt: 1_000,
      });
    }

    const firstResponse = await stub.fetch(
      "https://session/_eden/jobs?limit=2",
    );
    expect(firstResponse.status).toBe(200);
    const first = (await firstResponse.json()) as {
      readonly jobs: readonly { readonly jobId: string }[];
      readonly nextCursor: string | null;
    };
    expect(first.jobs).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    expect(first.nextCursor).not.toContain(first.jobs[1]?.jobId ?? "");

    const secondResponse = await stub.fetch(
      `https://session/_eden/jobs?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
    );
    expect(secondResponse.status).toBe(200);
    const second = (await secondResponse.json()) as {
      readonly jobs: readonly { readonly jobId: string }[];
      readonly nextCursor: string | null;
    };
    expect(second.jobs).toHaveLength(2);
    expect(second.nextCursor).not.toBeNull();

    const thirdResponse = await stub.fetch(
      `https://session/_eden/jobs?limit=2&cursor=${encodeURIComponent(second.nextCursor ?? "")}`,
    );
    expect(thirdResponse.status).toBe(200);
    const third = (await thirdResponse.json()) as {
      readonly jobs: readonly { readonly jobId: string }[];
      readonly nextCursor: string | null;
    };
    expect(third.jobs).toHaveLength(1);
    expect(third.nextCursor).toBeNull();

    const invalidResponse = await stub.fetch(
      "https://session/_eden/jobs?cursor=not-a-valid-cursor",
    );
    expect(invalidResponse.status).toBe(400);
  }, 15_000);

  test("keeps inspection complete when recovery mutates an unseen job between pages", async () => {
    const sessionId = createOpaqueSessionId();
    const stub = sessionStub(sessionId);
    await initializeSession(stub, sessionId);
    const createdAt = "2026-08-11T00:00:00.000Z";

    await runInDurableObject(stub, (_instance, state) => {
      for (let index = 0; index < 5; index += 1) {
        state.storage.sql.exec(
          `INSERT INTO jobs (
            job_id, session_id, kind, status, due_at, attempts, max_attempts,
            last_error, recovery_action, created_at, updated_at, completed_at
          ) VALUES (?, ?, ?, 'dead', ?, 3, 3, ?, ?, ?, ?, ?)`,
          `job_mutation_${index}`,
          sessionId,
          "checkpoint",
          1_000,
          "safe failure",
          "mark-complete",
          createdAt,
          createdAt,
          createdAt,
        );
      }
    });

    const first = await runInDurableObject(stub, (instance) =>
      (instance as EdenSession).inspectRecoveryJobs({ limit: 2 }),
    );
    expect(first.jobs.map(({ jobId }) => jobId)).toEqual([
      "job_mutation_0",
      "job_mutation_1",
    ]);
    expect(first.nextCursor).not.toBeNull();

    await runInDurableObject(stub, (instance) =>
      (instance as EdenSession).recoverRecoveryJob("job_mutation_2", {
        recoveryAction: "mark-complete",
        dueAt: 1,
      }),
    );

    const seen = new Set(first.jobs.map(({ jobId }) => jobId));
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const page = await runInDurableObject(stub, (instance) =>
        (instance as EdenSession).inspectRecoveryJobs({
          cursor: cursor ?? undefined,
          limit: 2,
        }),
      );
      for (const job of page.jobs) {
        expect(seen.has(job.jobId)).toBe(false);
        seen.add(job.jobId);
      }
      cursor = page.nextCursor;
    }

    expect(seen).toEqual(
      new Set([
        "job_mutation_0",
        "job_mutation_1",
        "job_mutation_2",
        "job_mutation_3",
        "job_mutation_4",
      ]),
    );
  }, 15_000);

  test("quarantines completed legacy jobs with unknown actions during rehydration", async () => {
    const sessionId = createOpaqueSessionId();
    const stub = sessionStub(sessionId);
    await initializeSession(stub, sessionId);
    const createdAt = "2026-08-11T00:00:00.000Z";

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO jobs (
          job_id, session_id, kind, status, due_at, attempts, max_attempts,
          last_error, recovery_action, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, 'completed', ?, 1, 3, NULL, ?, ?, ?, ?)`,
        "job_completed_legacy_unknown",
        sessionId,
        "checkpoint",
        1_000,
        "removed-action",
        createdAt,
        createdAt,
        createdAt,
      );
    });

    await import("cloudflare:test").then(({ evictDurableObject }) =>
      evictDurableObject(stub),
    );

    const snapshot = await runInDurableObject(stub, (_instance, state) =>
      readSessionRehydratedState(state.storage.sql, sessionId),
    );
    expect(snapshot.jobs).toEqual([
      expect.objectContaining({
        jobId: "job_completed_legacy_unknown",
        status: "dead",
        recoveryAction: "removed-action",
        lastError: "Unknown recovery action",
        completedAt: null,
      }),
    ]);
    expect(snapshot.errors).toEqual([
      expect.objectContaining({
        errorId: "err_job_job_completed_legacy_unknown",
        code: "recovery_job_failed",
        message: "Unknown recovery action",
        retryable: false,
        status: "open",
      }),
    ]);

    const inspected = await runInDurableObject(stub, (instance) =>
      (instance as EdenSession).inspectRecoveryJobs(),
    );
    expect(inspected.jobs[0]).toMatchObject({
      jobId: "job_completed_legacy_unknown",
      status: "dead",
    });
  }, 15_000);

  test("persists each version dimension independently across eviction", async () => {
    const sessionId = createOpaqueSessionId();
    const stub = sessionStub(sessionId);
    const versions = {
      runtime: "runtime-jobs-test",
      agentBundle: "bundle-jobs-test",
      manifest: "manifest-jobs-test",
      protocol: "protocol-jobs-test",
      schema: 47,
    } as const;
    await initializeSession(stub, sessionId, versions);

    const before = await inspect(stub);
    expect(before.jobs).toEqual([]);

    const schemaBefore = await stub.fetch("https://session/_eden/schema");
    await schemaBefore.arrayBuffer();
    const { evictDurableObject } = await import("cloudflare:test");
    await evictDurableObject(stub);

    const schemaAfter = await stub.fetch("https://session/_eden/schema");
    const body = (await schemaAfter.json()) as {
      readonly sessionMeta: {
        readonly runtimeVersion: string;
        readonly agentBundleVersion: string;
        readonly manifestVersion: string;
        readonly protocolVersion: string;
        readonly schemaVersion: number;
        readonly artifactSchemaVersion: number;
      };
    };
    expect(body.sessionMeta).toMatchObject({
      runtimeVersion: versions.runtime,
      agentBundleVersion: versions.agentBundle,
      manifestVersion: versions.manifest,
      protocolVersion: versions.protocol,
      schemaVersion: SESSION_SCHEMA_VERSION,
      artifactSchemaVersion: versions.schema,
    });
  }, 15_000);
});
