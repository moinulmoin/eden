import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";

const DEFAULT_MAX_BUFFER = 1024 * 1024;
const TERMINATION_GRACE_MS = 1_000;
const KILL_GRACE_MS = 2_000;
const PROCESS_SNAPSHOT_TIMEOUT_MS = 250;
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
    lastFailure: undefined,
  };
}

function captureSnapshot(reservation) {
  try {
    const entries = reservation.snapshot();
    if (!Array.isArray(entries)) {
      reservation.observationFailed = true;
      reservation.lastFailure = "process-observation-failed";
      return undefined;
    }
    return entries;
  } catch {
    reservation.observationFailed = true;
    reservation.lastFailure = "process-observation-failed";
    return undefined;
  }
}

function childIsTerminal(reservation) {
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
    if (allowTerminalRootGone && childIsTerminal(reservation)) {
      if (
        !reservation.identityObserved ||
        reservation.observationFailed ||
        reservation.identityMismatch
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
      return {
        entries,
        owned: [],
        rootPresent: false,
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
    childIsTerminal(reservation) || root.state?.startsWith("Z") === true;
  const terminalRootIdentity =
    allowTerminalRootGone &&
    rootIsTerminal &&
    reservation.identityObserved &&
    !reservation.observationFailed &&
    !reservation.identityMismatch &&
    root.pid === rootPid &&
    (process.platform === "win32" || root.pgid === reservation.groupId) &&
    root.start === reservation.startId;
  if (terminalRootIdentity) {
    const owned = processTree(entries, root);
    return {
      entries,
      owned,
      rootPresent: true,
      terminalRoot: true,
      verified: true,
      failure: undefined,
    };
  }

  if (!root.command.includes(reservation.marker)) {
    reservation.identityMismatch = true;
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
    reservation.identityMismatch = true;
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
    reservation.identityMismatch = true;
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
    reservation.identityMismatch = true;
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
  for (const entry of owned) {
    reservation.knownPids.add(entry.pid);
    reservation.knownGroups.add(entry.pgid);
  }
  reservation.lastFailure = undefined;
  return {
    entries,
    owned,
    rootPresent: true,
    verified: true,
    failure: undefined,
  };
}

function remainingOwnedEntries(
  reservation,
  entries,
  { excludeTerminalRoot = false } = {},
) {
  return entries.filter(
    (entry) =>
      reservation.knownPids.has(entry.pid) ||
      reservation.knownGroups.has(entry.pgid),
  ).filter(
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
    if (!observed.verified || observed.entries === undefined) {
      return {
        verified: false,
        failure: observed.failure ?? "cleanup-unverified",
        remaining:
          observed.entries === undefined
            ? undefined
            : remainingOwnedEntries(reservation, observed.entries),
        terminalRoot: observed.terminalRoot === true,
      };
    }

    const remaining = remainingOwnedEntries(reservation, observed.entries, {
      excludeTerminalRoot: observed.terminalRoot === true,
    });
    if (
      remaining.length === 0 &&
      (childIsTerminal(reservation) || observed.terminalRoot === true)
    ) {
      return {
        verified: true,
        failure: undefined,
        remaining,
        terminalRoot: observed.terminalRoot === true,
      };
    }
    lastFailure = observed.rootPresent
      ? "owned-processes-still-running"
      : "missing-root-process";
    await wait(50);
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
      (childIsTerminal(reservation) || observed.terminalRoot === true)
    ) {
      return {
        verified: true,
        failure: undefined,
        remaining,
        terminalRoot: observed.terminalRoot === true,
      };
    }
  }
  return {
    verified: false,
    failure:
      observed.failure ??
      lastFailure ??
      reservation.lastFailure ??
      "cleanup-unverified",
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
function signalOwnedTree(reservation, signal) {
  if (
    reservation.child === undefined ||
    reservation.child.pid === undefined
  ) {
    return { sent: true, failure: undefined, signal };
  }

  const observed = observeOwnedTree(reservation);
  if (!observed.verified || observed.owned === undefined) {
    return {
      sent: false,
      failure: observed.failure ?? "ownership-unverified",
      signal,
    };
  }

  const root = observed.owned.find(
    (entry) => entry.pid === reservation.child?.pid,
  );
  if (root === undefined) {
    return { sent: false, failure: "missing-root-process", signal };
  }

  const target =
    process.platform === "win32" ? root.pid : -root.pgid;
  let sent = false;
  try {
    sent = reservation.sendSignal(target, signal) === true;
  } catch {
    sent = false;
  }
  return {
    sent,
    failure: sent ? undefined : "signal-failed",
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

  if (childIsTerminal(reservation)) {
    const settled = await waitForOwnedTreeEmpty(reservation, KILL_GRACE_MS);
    return {
      verified: settled.verified,
      failure: settled.failure,
      lastSignal: undefined,
      settled,
    };
  }

  const term = signalOwnedTree(reservation, "SIGTERM");
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
  const kill = signalOwnedTree(reservation, "SIGKILL");
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
    !reservation.observationFailed &&
    !reservation.identityMismatch &&
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
  const reportedSignal = signal ?? (timedOut || aborted ? lastSignal : null);
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
    reservation.observationFailed = false;
    reservation.identityMismatch = false;
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
  };
  return result;
}

async function waitForOwnedIdentity(reservation, timeoutMs = 500) {
  if (process.platform === "win32") return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observed = observeOwnedTree(reservation);
    if (observed.verified) return true;
    if (childIsTerminal(reservation)) return false;
    await wait(10);
  }
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
  let settled = false;
  let timeoutHandle;
  let abortListener;
  let terminatePromise;
  let resolveExit;
  let resolveCancellation;
  let finalResult;
  let outputLimitExceeded = false;

  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const cancellationPromise = new Promise((resolve) => {
    resolveCancellation = resolve;
  });

  const requestTermination = (reason) => {
    if (reason === "timeout") timedOut = true;
    if (reason === "abort") aborted = true;
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
      reservation.exitObserved = true;
      if (!settled) {
        settled = true;
        resolveExit();
      }
    });
    child.once("exit", (code, signalName) => {
      exitCode = code;
      exitSignal = signalName;
      reservation.exitObserved = true;
      if (!settled) {
        settled = true;
        resolveExit();
      }
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

    const ownershipEstablished = await waitForOwnedIdentity(reservation);
    if (!ownershipEstablished) {
      spawnError = new Error(
        "Owned process identity could not be verified; cleanup failed closed.",
      );
      if (!childIsTerminal(reservation)) {
        await requestTermination("ownership");
      }
    }

    await Promise.race([exitPromise, timeoutPromise, cancellationPromise]);
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
    reservation.identityPromise = waitForOwnedIdentity(reservation);
    child.terminateOwned = async () => {
      await reservation.identityPromise;
      const termination = await terminateOwnedTree(reservation);
      const verified = await verifyAndRelease(reservation, termination);
      return verified.cleanupVerified;
    };
    child.once("error", () => {
      reservation.spawnFailed = true;
    });
    child.once("exit", () => {
      void waitForOwnedTreeEmpty(reservation, KILL_GRACE_MS).then((empty) => {
        if (empty.verified) activeReservations.delete(reservation);
      });
    });
    return child;
  } catch (error) {
    activeReservations.delete(reservation);
    throw error;
  }
}
