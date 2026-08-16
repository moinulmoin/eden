import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";

const DEFAULT_MAX_BUFFER = 1024 * 1024;
const TERMINATION_GRACE_MS = 1_000;
const KILL_GRACE_MS = 2_000;
const PROCESS_SNAPSHOT_TIMEOUT_MS = 250;
// A process can be visible to `ps` only after spawn has returned and can be
// briefly absent while the kernel is reaping it. Four snapshot budgets plus
// one termination-sized margin make startup evidence bounded without making a
// single transient observation permanently sticky.
const STARTUP_IDENTITY_TIMEOUT_MS =
  PROCESS_SNAPSHOT_TIMEOUT_MS * 4 + TERMINATION_GRACE_MS;
const OBSERVATION_RETRY_DELAY_MS = 50;
const activeReservations = new Set();

function boundedText(parts) {
  return Buffer.concat(parts).toString("utf8");
}

function appendBounded(parts, state, chunk, maxBuffer) {
  if (state.bytes >= maxBuffer) {
    state.truncated = true;
    return;
  }
  const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const remaining = maxBuffer - state.bytes;
  if (value.byteLength > remaining) {
    parts.push(value.subarray(0, remaining));
    state.bytes = maxBuffer;
    state.truncated = true;
    return;
  }
  parts.push(value);
  state.bytes += value.byteLength;
}

/**
 * Capture a complete process snapshot. An unavailable or malformed `ps`
 * result is represented as undefined rather than as an empty process list.
 * Callers must therefore fail closed when ownership cannot be observed.
 */
export function snapshotOwnedProcesses() {
  try {
    const output = execFileSync(
      "ps",
      ["-axo", "pid=,ppid=,pgid=,start=,stat=,command="],
      {
        encoding: "utf8",
        timeout: PROCESS_SNAPSHOT_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const entries = [];
    for (const line of output.split(/\r?\n/u)) {
      if (line.trim().length === 0) continue;
      const match = line.match(
        /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*?)\s*$/u,
      );
      if (match === null) return undefined;
      entries.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        start: match[4],
        state: match[5],
        command: match[6],
      });
    }
    return entries;
  } catch {
    return undefined;
  }
}

function sendProcessSignal(target, signal) {
  try {
    process.kill(target, signal);
    return true;
  } catch {
    return false;
  }
}

function createReservation(label, options = {}) {
  return {
    label,
    marker: `eden-owned-${label}-${randomUUID()}`,
    child: undefined,
    groupId: undefined,
    snapshot: options.snapshot ?? snapshotOwnedProcesses,
    sendSignal: options.sendSignal ?? sendProcessSignal,
    identityObserved: false,
    observationFailed: false,
    identityMismatch: false,
    startId: undefined,
    knownPids: new Set(),
    knownGroups: new Set(),
    knownIdentities: new Map(),
    identityAttempted: false,
    lastFailure: undefined,
    naturalExitVerified: false,
  };
}

function isProcessEntry(entry) {
  return (
    entry !== null &&
    typeof entry === "object" &&
    Number.isSafeInteger(entry.pid) &&
    entry.pid > 0 &&
    Number.isSafeInteger(entry.ppid) &&
    entry.ppid >= 0 &&
    Number.isSafeInteger(entry.pgid) &&
    entry.pgid > 0 &&
    typeof entry.start === "string" &&
    entry.start.length > 0 &&
    typeof entry.state === "string" &&
    entry.state.length > 0 &&
    typeof entry.command === "string"
  );
}

function captureSnapshot(reservation) {
  try {
    const entries = reservation.snapshot();
    if (!Array.isArray(entries) || entries.some((entry) => !isProcessEntry(entry))) {
      reservation.lastFailure = "process-observation-failed";
      return undefined;
    }
    return entries;
  } catch {
    reservation.lastFailure = "process-observation-failed";
    return undefined;
  }
}

function rememberOwnedEntries(reservation, entries) {
  for (const entry of entries) {
    reservation.knownPids.add(entry.pid);
    reservation.knownGroups.add(entry.pgid);
    reservation.knownIdentities.set(entry.pid, {
      start: entry.start,
      pgid: entry.pgid,
    });
  }
}

function knownOwnedEntries(reservation, entries) {
  return entries.filter((entry) => {
    const known = reservation.knownIdentities.get(entry.pid);
    if (known !== undefined) {
      return (
        known.start === entry.start &&
        known.pgid === entry.pgid
      );
    }
    return reservation.knownGroups.has(entry.pgid);
  });
}

function persistObservationFailure(reservation, failure) {
  reservation.lastFailure = failure;
  if (failure === "process-observation-failed") {
    reservation.observationFailed = true;
  }
  if (
    failure === "root-marker-mismatch" ||
    failure === "root-pid-mismatch" ||
    failure === "root-pgid-mismatch" ||
    failure === "root-start-mismatch"
  ) {
    reservation.identityMismatch = true;
  }
}

function childIsTerminal(reservation) {
  return childHasExited(reservation);
}

function childHasExited(reservation) {
  const child = reservation.child;
  return (
    child === undefined ||
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null ||
    reservation.exitObserved === true ||
    reservation.spawnFailed === true
  );
}

function childHasClosed(reservation) {
  const child = reservation.child;
  return (
    child === undefined ||
    child.pid === undefined ||
    reservation.closeObserved === true ||
    reservation.spawnFailed === true
  );
}

// An empty process snapshot is not evidence that a terminal root exited
// naturally. Node must first report the root's close event (or spawn failure).
function childHasObservedTerminalEvent(reservation) {
  return (
    reservation.closeObserved === true ||
    reservation.spawnFailed === true
  );
}

function processTree(entries, root) {
  const byParent = new Map();
  for (const entry of entries) {
    const children = byParent.get(entry.ppid) ?? [];
    children.push(entry);
    byParent.set(entry.ppid, children);
  }
  const owned = [];
  const seen = new Set();
  const visit = (entry) => {
    if (seen.has(entry.pid)) return;
    seen.add(entry.pid);
    owned.push(entry);
    for (const child of byParent.get(entry.pid) ?? []) visit(child);
  };
  visit(root);
  return owned;
}

function hasPotentialOwnedProcess(reservation, entries) {
  const rootPid = reservation.child?.pid;
  if (rootPid === undefined) return false;
  if (
    entries.some(
      (entry) =>
        entry.pid === rootPid ||
        entry.ppid === rootPid ||
        (process.platform === "win32"
          ? entry.pid === reservation.groupId
          : reservation.groupId !== undefined &&
            entry.pgid === reservation.groupId),
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Revalidate the complete root identity for one observation. This function
 * intentionally does not consult identityObserved: every signal escalation
 * must perform a new marker/PID/start/PGID check.
 */
function observeOwnedTree(reservation, { allowTerminalRootGone = false } = {}) {
  const entries = captureSnapshot(reservation);
  if (entries === undefined) {
    return {
      entries: undefined,
      owned: undefined,
      rootPresent: false,
      verified: false,
      failure: "process-observation-failed",
    };
  }

  const rootPid = reservation.child?.pid;
  if (rootPid === undefined) {
    if (
      allowTerminalRootGone &&
      childIsTerminal(reservation) &&
      childHasObservedTerminalEvent(reservation)
    ) {
      reservation.naturalExitVerified = true;
      reservation.lastFailure = undefined;
      return {
        entries,
        owned: [],
        rootPresent: false,
        terminalRoot: true,
        verified: true,
        failure: undefined,
      };
    }
    reservation.lastFailure = "missing-root-pid";
    return {
      entries,
      owned: [],
      rootPresent: false,
      verified: false,
      failure: "missing-root-pid",
    };
  }
  const root = entries.find((entry) => entry.pid === rootPid);
  if (root === undefined) {
    if (
      allowTerminalRootGone &&
      childIsTerminal(reservation) &&
      childHasObservedTerminalEvent(reservation)
    ) {
      if (!hasPotentialOwnedProcess(reservation, entries)) {
        reservation.naturalExitVerified = true;
        reservation.lastFailure = undefined;
        return {
          entries,
          owned: [],
          rootPresent: false,
          terminalRoot: true,
          verified: true,
          failure: undefined,
        };
      }
      if (
        !reservation.identityObserved ||
        reservation.observationFailed ||
        reservation.identityMismatch ||
        knownOwnedEntries(reservation, entries).length === 0
      ) {
        reservation.lastFailure = "missing-root-identity";
        return {
          entries,
          owned: [],
          rootPresent: false,
          verified: false,
          failure: "missing-root-identity",
        };
      }
      const owned = knownOwnedEntries(reservation, entries);
      return {
        entries,
        owned,
        rootPresent: false,
        terminalRoot: true,
        verified: true,
        failure: undefined,
      };
    }
    reservation.lastFailure = "missing-root-process";
    return {
      entries,
      owned: [],
      rootPresent: false,
      verified: false,
      failure: "missing-root-process",
    };
  }

  const rootIsTerminal =
    childIsTerminal(reservation) || root.state.startsWith("Z");
  const terminalRootIdentity =
    allowTerminalRootGone &&
    rootIsTerminal &&
    reservation.identityObserved &&
    !reservation.observationFailed &&
    !reservation.identityMismatch &&
    root.command.includes(reservation.marker) &&
    root.pid === rootPid &&
    (process.platform === "win32" || root.pgid === reservation.groupId) &&
    root.start === reservation.startId;
  if (terminalRootIdentity) {
    const owned = processTree(entries, root);
    rememberOwnedEntries(reservation, owned);
    return {
      entries,
      owned,
      rootPresent: true,
      terminalRoot: rootIsTerminal,
      verified: true,
      failure: undefined,
    };
  }

  if (!root.command.includes(reservation.marker)) {
    reservation.lastFailure = "root-marker-mismatch";
    return {
      entries,
      owned: [],
      rootPresent: true,
      verified: false,
      failure: "root-marker-mismatch",
    };
  }
  if (root.pid !== rootPid) {
    reservation.lastFailure = "root-pid-mismatch";
    return {
      entries,
      owned: [],
      rootPresent: true,
      verified: false,
      failure: "root-pid-mismatch",
    };
  }
  if (
    process.platform !== "win32" &&
    (reservation.groupId === undefined || root.pgid !== reservation.groupId)
  ) {
    reservation.lastFailure = "root-pgid-mismatch";
    return {
      entries,
      owned: [],
      rootPresent: true,
      verified: false,
      failure: "root-pgid-mismatch",
    };
  }
  if (
    reservation.startId !== undefined &&
    root.start !== reservation.startId
  ) {
    reservation.lastFailure = "root-start-mismatch";
    return {
      entries,
      owned: [],
      rootPresent: true,
      verified: false,
      failure: "root-start-mismatch",
    };
  }
  if (reservation.startId === undefined) {
    reservation.startId = root.start;
  }

  const owned = processTree(entries, root);
  reservation.identityObserved = true;
  rememberOwnedEntries(reservation, owned);
  reservation.lastFailure = undefined;
  return {
    entries,
    owned,
    rootPresent: true,
    terminalRoot: childIsTerminal(reservation) || root.state.startsWith("Z"),
    verified: true,
    failure: undefined,
  };
}

function remainingOwnedEntries(
  reservation,
  entries,
  { excludeTerminalRoot = false } = {},
) {
  return knownOwnedEntries(reservation, entries).filter(
    (entry) =>
      !excludeTerminalRoot ||
      entry.pid !== reservation.child?.pid,
  );
}

function wait(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function waitForOwnedTreeEmpty(reservation, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = reservation.lastFailure ?? "cleanup-unverified";
  while (Date.now() < deadline) {
    const observed = observeOwnedTree(reservation, {
      allowTerminalRootGone: true,
    });
    if (observed.verified && observed.entries !== undefined) {
      const remaining = remainingOwnedEntries(reservation, observed.entries, {
        excludeTerminalRoot: observed.terminalRoot === true,
      });
      if (
        remaining.length === 0 &&
        childHasClosed(reservation) &&
        (childHasExited(reservation) || observed.terminalRoot === true)
      ) {
        return {
          verified: true,
          failure: undefined,
          remaining,
          terminalRoot: observed.terminalRoot === true,
        };
      }
      lastFailure = childHasClosed(reservation)
        ? observed.rootPresent
          ? "owned-processes-still-running"
          : "missing-root-process"
        : "process-close-pending";
    } else {
      lastFailure = observed.failure ?? "cleanup-unverified";
    }
    await wait(OBSERVATION_RETRY_DELAY_MS);
  }

  const observed = observeOwnedTree(reservation, {
    allowTerminalRootGone: true,
  });
  if (observed.verified && observed.entries !== undefined) {
    const remaining = remainingOwnedEntries(reservation, observed.entries, {
      excludeTerminalRoot: observed.terminalRoot === true,
    });
    if (
      remaining.length === 0 &&
      childHasClosed(reservation) &&
      (childHasExited(reservation) || observed.terminalRoot === true)
    ) {
      return {
        verified: true,
        failure: undefined,
        remaining,
        terminalRoot: observed.terminalRoot === true,
      };
    }
  }
  const failure =
    observed.failure ??
    (!childHasClosed(reservation)
      ? "process-close-pending"
      : lastFailure ?? reservation.lastFailure ?? "cleanup-unverified");
  persistObservationFailure(reservation, failure);
  return {
    verified: false,
    failure,
    remaining:
      observed.entries === undefined
        ? undefined
        : remainingOwnedEntries(reservation, observed.entries),
    terminalRoot: observed.terminalRoot === true,
  };
}

/**
 * Send one signal only after a fresh identity observation. In particular,
 * this never uses an identityVerified cache or a previously observed PGID.
 */
async function signalOwnedTree(
  reservation,
  signal,
  timeoutMs = TERMINATION_GRACE_MS,
  { allowTerminalRootGone = true } = {},
) {
  if (
    reservation.child === undefined ||
    reservation.child.pid === undefined
  ) {
    return { sent: true, failure: undefined, signal };
  }

  const deadline = Date.now() + timeoutMs;
  let lastFailure = reservation.lastFailure ?? "ownership-unverified";
  while (Date.now() < deadline) {
    const observed = observeOwnedTree(reservation, {
      allowTerminalRootGone,
    });
    if (observed.verified && observed.owned !== undefined) {
      const root = observed.owned.find(
        (entry) => entry.pid === reservation.child?.pid,
      );
      if (root === undefined) {
        if (childHasExited(reservation) && observed.owned.length === 0) return { sent: true, failure: undefined, signal };
        lastFailure = observed.failure ?? "missing-root-identity";
      } else {
        const target =
          process.platform === "win32" ? root.pid : -root.pgid;
        let sent = false;
        try {
          sent = reservation.sendSignal(target, signal) === true;
        } catch {
          sent = false;
        }
        if (sent || childHasExited(reservation)) {
          return {
            sent: sent || childHasExited(reservation),
            failure: sent || childHasExited(reservation)
              ? undefined
              : "signal-failed",
            signal,
          };
        }
        lastFailure = "signal-failed";
      }
    } else {
      lastFailure = observed.failure ?? lastFailure;
    }
    await wait(OBSERVATION_RETRY_DELAY_MS);
  }

  const observed = observeOwnedTree(reservation, {
    allowTerminalRootGone,
  });
  if (observed.verified && observed.owned !== undefined) {
    const root = observed.owned.find(
      (entry) => entry.pid === reservation.child?.pid,
    );
    if (root === undefined && childHasExited(reservation) && observed.owned.length === 0) {
      return { sent: true, failure: undefined, signal };
    }
  }
  persistObservationFailure(
    reservation,
    observed.failure ?? lastFailure ?? "ownership-unverified",
  );
  return {
    sent: false,
    failure: observed.failure ?? lastFailure ?? "signal-failed",
    signal,
  };
}

async function terminateOwnedTree(reservation) {
  if (reservation.child === undefined || reservation.child.pid === undefined) {
    return {
      verified: true,
      failure: undefined,
      lastSignal: undefined,
    };
  }

  if (!reservation.identityObserved) {
    let identityEstablished;
    if (reservation.identityPromise !== undefined && reservation.identityAttempted) {
      identityEstablished = await reservation.identityPromise;
    } else if (!reservation.identityAttempted) {
      reservation.identityPromise = waitForOwnedIdentity(reservation);
      identityEstablished = await reservation.identityPromise;
    }
    if (!identityEstablished) {
      const settled = await waitForOwnedTreeEmpty(reservation, KILL_GRACE_MS);
      if (settled.verified && settled.terminalRoot === true) {
        return {
          verified: true,
          failure: undefined,
          lastSignal: undefined,
          settled,
        };
      }
      return {
        verified: false,
        failure: settled.failure ?? "ownership-unverified",
        lastSignal: undefined,
        settled,
      };
    }
  }

  if (childIsTerminal(reservation)) {
    const settled = await waitForOwnedTreeEmpty(reservation, KILL_GRACE_MS);
    if (settled.verified) {
      return {
        verified: true,
        failure: undefined,
        lastSignal: undefined,
        settled,
      };
    }
    if (
      settled.remaining === undefined ||
      settled.remaining.length === 0
    ) {
      return {
        verified: false,
        failure: settled.failure ?? "cleanup-unverified",
        lastSignal: undefined,
        settled,
      };
    }
    const kill = await signalOwnedTree(reservation, "SIGKILL", undefined, {
      allowTerminalRootGone: true,
    });
    const killSettled = await waitForOwnedTreeEmpty(
      reservation,
      KILL_GRACE_MS,
    );
    const verified = kill.sent && killSettled.verified;
    return {
      verified,
      failure: verified
        ? undefined
        : kill.failure ?? killSettled.failure ?? settled.failure,
      lastSignal: kill.sent ? kill.signal : undefined,
      settled: killSettled,
    };
  }

  const term = await signalOwnedTree(reservation, "SIGTERM", undefined, {
    allowTerminalRootGone: true,
  });
  const termSettled = await waitForOwnedTreeEmpty(
    reservation,
    TERMINATION_GRACE_MS,
  );
  if (termSettled.verified && term.sent) {
    return {
      verified: true,
      failure: undefined,
      lastSignal: term.signal,
      settled: termSettled,
    };
  }

  // SIGKILL is independently identity-checked by signalOwnedTree. A failed
  // SIGTERM observation must never authorize a cached-group SIGKILL.
  const kill = await signalOwnedTree(reservation, "SIGKILL", undefined, {
    allowTerminalRootGone: true,
  });
  const killSettled = await waitForOwnedTreeEmpty(reservation, KILL_GRACE_MS);
  const verified = term.sent && kill.sent && killSettled.verified;
  return {
    verified,
    failure: verified
      ? undefined
      : kill.failure ??
        term.failure ??
        killSettled.failure ??
        termSettled.failure ??
        "cleanup-unverified",
    lastSignal: kill.sent ? kill.signal : term.sent ? term.signal : undefined,
    settled: killSettled,
  };
}

async function verifyAndRelease(reservation, termination) {
  const settled =
    termination?.settled ??
    (reservation.child === undefined || reservation.spawnFailed
      ? {
          verified: true,
          failure: undefined,
          remaining: [],
        }
      : await waitForOwnedTreeEmpty(reservation, KILL_GRACE_MS));
  const cleanupVerified =
    (termination?.verified ?? true) &&
    settled.verified &&
    (reservation.naturalExitVerified ||
      (!reservation.observationFailed && !reservation.identityMismatch)) &&
    (reservation.child === undefined ||
      reservation.child.pid === undefined ||
      childIsTerminal(reservation) ||
      settled.terminalRoot === true);
  if (cleanupVerified) activeReservations.delete(reservation);
  else reservation.uncertainTermination = true;
  return {
    cleanupVerified,
    cleanupFailure: cleanupVerified
      ? undefined
      : termination?.failure ??
        settled.failure ??
        reservation.lastFailure ??
        "cleanup-unverified",
    remaining:
      settled.remaining ??
      (await waitForOwnedTreeEmpty(reservation, 1)).remaining,
  };
}

function resultFor({
  reservation,
  code,
  signal,
  error,
  timedOut,
  aborted,
  cleanupVerified,
  cleanupFailure,
  lastSignal,
  stdout,
  stderr,
  stdoutTruncated,
  stderrTruncated,
  outputLimitExceeded,
}) {
  const reportedSignal =
    signal ?? (timedOut || aborted || outputLimitExceeded ? lastSignal : null);
  const result = {
    ok:
      error === undefined &&
      !timedOut &&
      !aborted &&
      !outputLimitExceeded &&
      code === 0 &&
      reportedSignal === null &&
      cleanupVerified &&
      !stdoutTruncated &&
      !stderrTruncated,
    code,
    signal: reportedSignal,
    error,
    timedOut,
    aborted,
    cleanupVerified,
    unresolvedCleanup: !cleanupVerified,
    cleanupFailure,
    cleanupStatus: cleanupVerified ? "verified" : "unresolved",
    stdout,
    stderr,
    stdoutTruncated,
    stderrTruncated,
    outputLimitExceeded,
    terminationReason: outputLimitExceeded
      ? "output-limit-exceeded"
      : timedOut
        ? "timeout"
        : aborted
          ? "aborted"
          : signal !== null
            ? "signal"
            : code !== 0
              ? "exit-code"
            : cleanupVerified
              ? undefined
              : "cleanup-failure",
    remainingPids: async () => {
      const observed = observeOwnedTree(reservation, {
        allowTerminalRootGone: true,
      });
      if (
        !observed.verified ||
        observed.entries === undefined ||
        reservation.observationFailed ||
        reservation.identityMismatch
      ) {
        return undefined;
      }
      return remainingOwnedEntries(reservation, observed.entries, {
        excludeTerminalRoot: observed.terminalRoot === true,
      }).map((entry) => entry.pid);
    },
  };
  result.retryCleanup = async () => {
    if (reservation.retryCleanupPromise !== undefined) {
      return reservation.retryCleanupPromise;
    }
    const attempt = (async () => {
      reservation.observationFailed = false;
      reservation.identityMismatch = false;
      reservation.identityAttempted = false;
      reservation.lastFailure = undefined;
      const termination = await terminateOwnedTree(reservation);
      const verified = await verifyAndRelease(reservation, termination);
      return {
        cleanupVerified: verified.cleanupVerified,
        unresolvedCleanup: !verified.cleanupVerified,
        cleanupFailure: verified.cleanupFailure,
        cleanupStatus: verified.cleanupVerified ? "verified" : "unresolved",
        remainingPids: verified.remaining?.map((entry) => entry.pid),
      };
    })();
    const completed = attempt.then((outcome) => {
      if (outcome.unresolvedCleanup) {
        reservation.retryCleanupPromise = undefined;
      }
      return outcome;
    });
    reservation.retryCleanupPromise = completed;
    return completed;
  };
  return result;
}

async function waitForOwnedIdentity(
  reservation,
  timeoutMs = STARTUP_IDENTITY_TIMEOUT_MS,
) {
  reservation.identityAttempted = true;
  if (process.platform === "win32") return false;
  const deadline = Date.now() + timeoutMs;
  let lastFailure = reservation.lastFailure ?? "ownership-unverified";
  while (Date.now() < deadline) {
    const observed = observeOwnedTree(reservation);
    if (observed.verified) return true;
    lastFailure = observed.failure ?? lastFailure;
    if (childIsTerminal(reservation)) {
      persistObservationFailure(reservation, lastFailure);
      return false;
    }
    await wait(OBSERVATION_RETRY_DELAY_MS);
  }
  const observed = observeOwnedTree(reservation);
  if (observed.verified) return true;
  persistObservationFailure(
    reservation,
    observed.failure ?? lastFailure ?? "ownership-unverified",
  );
  return false;
}

/**
 * Run one explicitly owned child. The reservation is installed before spawn,
 * and the process is put in a private process group on POSIX. A timeout or
 * abort always tears down that group and waits for an empty process snapshot
 * before returning. If identity, observation, or signaling cannot be proven,
 * the result is an explicit bounded unresolved-cleanup failure.
 */
export async function runOwnedProcess({
  file,
  args = [],
  cwd,
  env,
  timeoutMs,
  signal,
  label = "owned-process",
  maxBuffer = DEFAULT_MAX_BUFFER,
  snapshot,
  sendSignal,
}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("runOwnedProcess requires a finite positive timeoutMs");
  }
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer <= 0) {
    throw new TypeError("runOwnedProcess requires a positive maxBuffer");
  }

  const reservation = createReservation(label, { snapshot, sendSignal });
  activeReservations.add(reservation);

  const stdoutParts = [];
  const stderrParts = [];
  const stdoutState = { bytes: 0, truncated: false };
  const stderrState = { bytes: 0, truncated: false };
  const childEnv =
    env === undefined
      ? { ...process.env, EDEN_BEARER_SECRET: undefined }
      : env;
  let child;
  let timedOut = false;
  let aborted = false;
  let spawnError;
  let exitCode = null;
  let exitSignal = null;
  let timeoutHandle;
  let abortListener;
  let terminatePromise;
  let resolveExit;
  let resolveCancellation;
  let finalResult;
  let outputLimitExceeded = false;

  const completionPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const cancellationPromise = new Promise((resolve) => {
    resolveCancellation = resolve;
  });

  const requestTermination = (reason) => {
    if (reason === "timeout") timedOut = true;
    if (reason === "abort") aborted = true;
    if (reason === "output") outputLimitExceeded = true;
    resolveCancellation?.();
    if (terminatePromise !== undefined) return terminatePromise;
    terminatePromise = terminateOwnedTree(reservation);
    return terminatePromise;
  };

  const finish = async () => {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    if (signal !== undefined && abortListener !== undefined) {
      signal.removeEventListener("abort", abortListener);
    }
    let termination;
    if (
      child !== undefined &&
      child.pid !== undefined &&
      !childIsTerminal(reservation)
    ) {
      termination = await requestTermination(
        timedOut || aborted ? "cancel" : "cleanup",
      );
    } else if (reservation.groupId !== undefined) {
      termination = await requestTermination("cleanup");
    }
    const verified = await verifyAndRelease(reservation, termination);
    if (outputLimitExceeded && spawnError === undefined) {
      spawnError = new Error(
        `Owned process output limit exceeded (${maxBuffer} bytes).`,
      );
    }
    const cleanupVerified = verified.cleanupVerified;
    finalResult = resultFor({
      reservation,
      code: exitCode,
      signal: exitSignal,
      error: spawnError,
      timedOut,
      aborted,
      cleanupVerified,
      cleanupFailure: verified.cleanupFailure,
      lastSignal: termination?.lastSignal,
      stdout: boundedText(stdoutParts),
      stderr: boundedText(stderrParts),
      stdoutTruncated: stdoutState.truncated,
      stderrTruncated: stderrState.truncated,
      outputLimitExceeded,
    });
    return finalResult;
  };

  if (signal?.aborted === true) {
    aborted = true;
    return finish();
  }

  try {
    child = spawn(file, args, {
      cwd,
      env: childEnv,
      detached: process.platform !== "win32",
      argv0: reservation.marker,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    reservation.child = child;
    reservation.groupId = process.platform === "win32" ? child.pid : child.pid;

    child.stdout?.on("data", (chunk) => {
      appendBounded(stdoutParts, stdoutState, chunk, maxBuffer);
      if (stdoutState.truncated && !outputLimitExceeded) {
        outputLimitExceeded = true;
        void requestTermination("output");
      }
    });
    child.stderr?.on("data", (chunk) => {
      appendBounded(stderrParts, stderrState, chunk, maxBuffer);
      if (stderrState.truncated && !outputLimitExceeded) {
        outputLimitExceeded = true;
        void requestTermination("output");
      }
    });
    child.once("error", (error) => {
      spawnError = error;
      reservation.spawnFailed = true;
    });
    child.once("exit", (code, signalName) => {
      exitCode = code;
      exitSignal = signalName;
      reservation.exitObserved = true;
    });
    child.once("close", (code, signalName) => {
      if (!reservation.exitObserved) {
        exitCode = code;
        exitSignal = signalName;
      }
      reservation.closeObserved = true;
      resolveExit();
    });

    let resolveTimeout;
    const timeoutPromise = new Promise((resolve) => {
      resolveTimeout = resolve;
    });
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      resolveTimeout();
      void requestTermination("timeout");
    }, timeoutMs);
    abortListener = () => {
      aborted = true;
      resolveCancellation?.();
      void requestTermination("abort");
    };
    signal?.addEventListener("abort", abortListener, { once: true });
    if (signal?.aborted === true) abortListener();

    reservation.identityPromise = waitForOwnedIdentity(reservation);
    const ownershipEstablished = await reservation.identityPromise;
    if (!ownershipEstablished) {
      if (!childIsTerminal(reservation)) {
        spawnError = new Error(
          "Owned process identity could not be verified; cleanup failed closed.",
        );
        await requestTermination("ownership");
      }
    }

    await Promise.race([
      completionPromise,
      timeoutPromise,
      cancellationPromise,
    ]);
  } catch (error) {
    spawnError = error;
    reservation.spawnFailed = true;
  } finally {
    finalResult = await finish();
  }

  return finalResult;
}

export function ownedProcessReservationCount() {
  return activeReservations.size;
}

export function ownedProcessReservationLabels() {
  return [...activeReservations].map((reservation) => ({
    label: reservation.label,
    pid: reservation.child?.pid,
    groupId: reservation.groupId,
    failure: reservation.lastFailure,
    uncertain: reservation.uncertainTermination === true,
  }));
}

/**
 * Spawn a deliberately long-lived owned child for a lifecycle test. The
 * caller must invoke the attached terminateOwned method; unlike
 * runOwnedProcess this does not impose a wall-clock lifetime on a healthy
 * service.
 */
export function spawnOwnedProcess({
  file,
  args = [],
  cwd,
  env,
  label = "owned-service",
  stdio = "ignore",
  snapshot,
  sendSignal,
}) {
  const reservation = createReservation(label, { snapshot, sendSignal });
  activeReservations.add(reservation);
  try {
    const child = spawn(file, args, {
      cwd,
      env:
        env === undefined
          ? { ...process.env, EDEN_BEARER_SECRET: undefined }
          : env,
      detached: process.platform !== "win32",
      argv0: reservation.marker,
      stdio,
      windowsHide: true,
    });
    reservation.child = child;
    reservation.groupId = process.platform === "win32" ? child.pid : child.pid;
    child.processIdentity = reservation.marker;
    child.closeObserved = false;
    reservation.identityPromise = waitForOwnedIdentity(reservation);
    child.identityReady = reservation.identityPromise;
    child.awaitIdentity = () => reservation.identityPromise;
    child.terminateOwned = () => {
      if (reservation.terminatePromise !== undefined) {
        return reservation.terminatePromise;
      }
      reservation.terminatePromise = (async () => {
        await reservation.identityPromise;
        reservation.observationFailed = false;
        reservation.identityMismatch = false;
        reservation.lastFailure = undefined;
        if (!reservation.identityObserved) {
          reservation.identityAttempted = false;
        }
        const termination = await terminateOwnedTree(reservation);
        const verified = await verifyAndRelease(reservation, termination);
        return verified.cleanupVerified;
      })();
      const completed = reservation.terminatePromise.then((verified) => {
        if (!verified) reservation.terminatePromise = undefined;
        return verified;
      });
      reservation.terminatePromise = completed;
      return completed;
    };
    child.once("error", () => {
      reservation.spawnFailed = true;
    });
    child.once("exit", () => {
      reservation.exitObserved = true;
    });
    child.once("close", () => {
      reservation.closeObserved = true;
      child.closeObserved = true;
      void Promise.resolve(reservation.identityPromise).then(() =>
        waitForOwnedTreeEmpty(reservation, KILL_GRACE_MS),
      ).then((empty) => {
        if (empty.verified) {
          activeReservations.delete(reservation);
          return;
        }
        void child.terminateOwned();
      });
    });
    return child;
  } catch (error) {
    activeReservations.delete(reservation);
    throw error;
  }
}
