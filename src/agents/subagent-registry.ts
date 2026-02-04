import type { SubagentOrchestrationConfig } from "../config/types.agent-defaults.js";
import { loadConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { type DeliveryContext, normalizeDeliveryContext } from "../utils/delivery-context.js";
import { runSubagentAnnounceFlow, type SubagentRunOutcome } from "./subagent-announce.js";
import {
  loadSubagentRegistryFromDisk,
  saveSubagentRegistryToDisk,
} from "./subagent-registry.store.js";
import { resolveAgentTimeoutMs } from "./timeout.js";

const log = createSubsystemLogger("subagent-orchestration");

/**
 * Default orchestration configuration values.
 */
const DEFAULT_ORCHESTRATION: Required<SubagentOrchestrationConfig> = {
  retryOnFailure: false,
  maxRetries: 3,
  backoffMultiplier: 2,
  initialDelayMs: 1000,
  maxDelayMs: 60000,
  verifyCompletion: false,
  verificationPrompt: "",
  verificationTimeoutSeconds: 30,
  retryOnVerificationFailure: true,
  verificationHook: "",
};

export type SubagentRunRecord = {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  cleanup: "delete" | "keep";
  label?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
  archiveAtMs?: number;
  cleanupCompletedAt?: number;
  cleanupHandled?: boolean;
  /** Number of retry attempts made for this task. */
  retryCount?: number;
  /** Maximum retries allowed (from config at creation time). */
  maxRetries?: number;
  /** Timestamp when next retry is allowed (for backoff). */
  nextRetryAt?: number;
  /** Whether this run is a retry of a previous failed run. */
  isRetry?: boolean;
  /** Original run ID if this is a retry. */
  originalRunId?: string;
  /** Whether verification was attempted. */
  verificationAttempted?: boolean;
  /** Verification result if verified. */
  verificationResult?: "passed" | "failed" | "skipped";
  /** Orchestration config snapshot (for persistence). */
  orchestrationConfig?: SubagentOrchestrationConfig;
};

const subagentRuns = new Map<string, SubagentRunRecord>();
let sweeper: NodeJS.Timeout | null = null;
let listenerStarted = false;
let listenerStop: (() => void) | null = null;
// Use var to avoid TDZ when init runs across circular imports during bootstrap.
var restoreAttempted = false;

function persistSubagentRuns() {
  try {
    saveSubagentRegistryToDisk(subagentRuns);
  } catch {
    // ignore persistence failures
  }
}

const resumedRuns = new Set<string>();

function resumeSubagentRun(runId: string) {
  if (!runId || resumedRuns.has(runId)) {
    return;
  }
  const entry = subagentRuns.get(runId);
  if (!entry) {
    return;
  }
  if (entry.cleanupCompletedAt) {
    return;
  }

  if (typeof entry.endedAt === "number" && entry.endedAt > 0) {
    if (!beginSubagentCleanup(runId)) {
      return;
    }
    const requesterOrigin = normalizeDeliveryContext(entry.requesterOrigin);
    void runSubagentAnnounceFlow({
      childSessionKey: entry.childSessionKey,
      childRunId: entry.runId,
      requesterSessionKey: entry.requesterSessionKey,
      requesterOrigin,
      requesterDisplayKey: entry.requesterDisplayKey,
      task: entry.task,
      timeoutMs: 30_000,
      cleanup: entry.cleanup,
      waitForCompletion: false,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      label: entry.label,
      outcome: entry.outcome,
      retryCount: entry.retryCount,
      verificationResult: entry.verificationResult,
    }).then((didAnnounce) => {
      finalizeSubagentCleanup(runId, entry.cleanup, didAnnounce);
    });
    resumedRuns.add(runId);
    return;
  }

  // Wait for completion again after restart.
  const cfg = loadConfig();
  const waitTimeoutMs = resolveSubagentWaitTimeoutMs(cfg, undefined);
  void waitForSubagentCompletion(runId, waitTimeoutMs);
  resumedRuns.add(runId);
}

function restoreSubagentRunsOnce() {
  if (restoreAttempted) {
    return;
  }
  restoreAttempted = true;
  try {
    const restored = loadSubagentRegistryFromDisk();
    if (restored.size === 0) {
      return;
    }
    for (const [runId, entry] of restored.entries()) {
      if (!runId || !entry) {
        continue;
      }
      // Keep any newer in-memory entries.
      if (!subagentRuns.has(runId)) {
        subagentRuns.set(runId, entry);
      }
    }

    // Resume pending work.
    ensureListener();
    if ([...subagentRuns.values()].some((entry) => entry.archiveAtMs)) {
      startSweeper();
    }
    for (const runId of subagentRuns.keys()) {
      resumeSubagentRun(runId);
    }
  } catch {
    // ignore restore failures
  }
}

function resolveArchiveAfterMs(cfg?: ReturnType<typeof loadConfig>) {
  const config = cfg ?? loadConfig();
  const minutes = config.agents?.defaults?.subagents?.archiveAfterMinutes ?? 60;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(minutes)) * 60_000;
}

/**
 * Resolve orchestration configuration with defaults.
 * Override config takes precedence over user config from loadConfig.
 */
function resolveOrchestrationConfig(
  cfg?: ReturnType<typeof loadConfig>,
  overrideConfig?: SubagentOrchestrationConfig,
): Required<SubagentOrchestrationConfig> {
  const config = cfg ?? loadConfig();
  const userConfig = config.agents?.defaults?.subagents?.orchestration;
  // Priority: override > user config > defaults
  return {
    retryOnFailure:
      overrideConfig?.retryOnFailure ??
      userConfig?.retryOnFailure ??
      DEFAULT_ORCHESTRATION.retryOnFailure,
    maxRetries:
      overrideConfig?.maxRetries ?? userConfig?.maxRetries ?? DEFAULT_ORCHESTRATION.maxRetries,
    backoffMultiplier:
      overrideConfig?.backoffMultiplier ??
      userConfig?.backoffMultiplier ??
      DEFAULT_ORCHESTRATION.backoffMultiplier,
    initialDelayMs:
      overrideConfig?.initialDelayMs ??
      userConfig?.initialDelayMs ??
      DEFAULT_ORCHESTRATION.initialDelayMs,
    maxDelayMs:
      overrideConfig?.maxDelayMs ?? userConfig?.maxDelayMs ?? DEFAULT_ORCHESTRATION.maxDelayMs,
    verifyCompletion:
      overrideConfig?.verifyCompletion ??
      userConfig?.verifyCompletion ??
      DEFAULT_ORCHESTRATION.verifyCompletion,
    verificationPrompt:
      overrideConfig?.verificationPrompt ??
      userConfig?.verificationPrompt ??
      DEFAULT_ORCHESTRATION.verificationPrompt,
    verificationTimeoutSeconds:
      overrideConfig?.verificationTimeoutSeconds ??
      userConfig?.verificationTimeoutSeconds ??
      DEFAULT_ORCHESTRATION.verificationTimeoutSeconds,
    retryOnVerificationFailure:
      overrideConfig?.retryOnVerificationFailure ??
      userConfig?.retryOnVerificationFailure ??
      DEFAULT_ORCHESTRATION.retryOnVerificationFailure,
    verificationHook:
      overrideConfig?.verificationHook ??
      userConfig?.verificationHook ??
      DEFAULT_ORCHESTRATION.verificationHook,
  };
}

/**
 * Calculate exponential backoff delay for retry.
 */
function calculateRetryDelay(
  retryCount: number,
  config: Required<SubagentOrchestrationConfig>,
): number {
  const { initialDelayMs, backoffMultiplier, maxDelayMs } = config;
  const delay = initialDelayMs * backoffMultiplier ** retryCount;
  return Math.min(delay, maxDelayMs);
}

/**
 * Check if a task should be retried based on outcome and config.
 */
function shouldRetryTask(
  entry: SubagentRunRecord,
  config: Required<SubagentOrchestrationConfig>,
): boolean {
  if (!config.retryOnFailure) {
    return false;
  }

  const retryCount = entry.retryCount ?? 0;
  if (retryCount >= config.maxRetries) {
    log.debug("Max retries reached", {
      runId: entry.runId,
      retryCount,
      maxRetries: config.maxRetries,
    });
    return false;
  }

  // Only retry on error outcomes
  if (entry.outcome?.status !== "error") {
    return false;
  }

  return true;
}

/**
 * Build retry prompt that includes error context to help the agent avoid repeating mistakes.
 */
function buildRetryPrompt(entry: SubagentRunRecord, retryCount: number): string {
  const errorMessage = entry.outcome?.error ?? "Unknown error";
  const originalTask = entry.task;

  const retryContext = [
    `[RETRY ATTEMPT ${retryCount}/${entry.maxRetries ?? 3}]`,
    "",
    "The previous attempt to complete this task FAILED with the following error:",
    "---",
    errorMessage,
    "---",
    "",
    "IMPORTANT: Please analyze what went wrong and take a DIFFERENT approach this time.",
    "Do NOT repeat the same actions that caused the failure.",
    "If the error suggests a specific issue (missing file, permission denied, API error, etc.),",
    "address that issue before proceeding with the main task.",
    "",
    "Original task:",
    "---",
    originalTask,
    "---",
    "",
    "Please complete the task successfully, avoiding the previous error.",
  ].join("\n");

  return retryContext;
}

/**
 * Schedule a retry for a failed task.
 */
async function scheduleTaskRetry(
  entry: SubagentRunRecord,
  config: Required<SubagentOrchestrationConfig>,
): Promise<boolean> {
  const retryCount = (entry.retryCount ?? 0) + 1;
  const delay = calculateRetryDelay(retryCount - 1, config);
  const nextRetryAt = Date.now() + delay;
  const previousError = entry.outcome?.error ?? "Unknown error";

  log.info("Scheduling task retry", {
    runId: entry.runId,
    retryCount,
    delayMs: delay,
    task: entry.task.slice(0, 100),
    previousError: previousError.slice(0, 200),
  });

  // Update entry with retry info
  entry.retryCount = retryCount;
  entry.nextRetryAt = nextRetryAt;
  persistSubagentRuns();

  // Wait for backoff delay
  await new Promise((resolve) => setTimeout(resolve, delay));

  // Check if entry still exists and should retry
  const currentEntry = subagentRuns.get(entry.runId);
  if (!currentEntry || currentEntry.cleanupCompletedAt) {
    log.debug("Retry cancelled - entry no longer active", { runId: entry.runId });
    return false;
  }

  // Spawn retry via gateway
  try {
    const retryRunId = `${entry.runId}-retry-${retryCount}`;

    log.info("Executing task retry", {
      originalRunId: entry.runId,
      retryRunId,
      retryCount,
    });

    // Build retry prompt with error context
    const retryPrompt = buildRetryPrompt(currentEntry, retryCount);

    // Reset entry state for retry
    currentEntry.endedAt = undefined;
    currentEntry.outcome = undefined;
    currentEntry.cleanupHandled = false;
    currentEntry.startedAt = Date.now();
    currentEntry.isRetry = true;
    persistSubagentRuns();

    // Re-spawn the agent with the retry prompt that includes error context
    await callGateway({
      method: "agent.start",
      params: {
        key: entry.childSessionKey,
        prompt: retryPrompt,
        runId: retryRunId,
      },
      timeoutMs: 30_000,
    });

    // Wait for the retry completion
    const cfg = loadConfig();
    const waitTimeoutMs = resolveSubagentWaitTimeoutMs(cfg, undefined);
    void waitForSubagentCompletion(entry.runId, waitTimeoutMs);

    return true;
  } catch (err) {
    log.error("Failed to execute task retry", {
      runId: entry.runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// Pending retries map to prevent duplicate retry scheduling
const pendingRetries = new Set<string>();

// Pending verifications map to prevent duplicate verification
const pendingVerifications = new Set<string>();

/**
 * Registered verification hook handlers.
 * Hook name -> verification function that returns true for pass, false for fail.
 */
const verificationHooks = new Map<string, VerificationHookFn>();

export type VerificationHookFn = (params: {
  runId: string;
  task: string;
  outcome: SubagentRunOutcome;
  entry: SubagentRunRecord;
}) => Promise<VerificationResult>;

export type VerificationResult = {
  passed: boolean;
  reason?: string;
};

/**
 * Register a verification hook by name.
 */
export function registerVerificationHook(name: string, hook: VerificationHookFn): void {
  verificationHooks.set(name, hook);
  log.debug("Registered verification hook", { name });
}

/**
 * Unregister a verification hook by name.
 */
export function unregisterVerificationHook(name: string): boolean {
  const deleted = verificationHooks.delete(name);
  if (deleted) {
    log.debug("Unregistered verification hook", { name });
  }
  return deleted;
}

/**
 * Run task verification using configured hook or built-in verification.
 */
async function verifyTaskCompletion(
  entry: SubagentRunRecord,
  config: Required<SubagentOrchestrationConfig>,
): Promise<VerificationResult> {
  if (!config.verifyCompletion) {
    return { passed: true, reason: "Verification disabled" };
  }

  entry.verificationAttempted = true;
  persistSubagentRuns();

  const timeoutMs = config.verificationTimeoutSeconds * 1000;

  // Use custom hook if specified
  if (config.verificationHook) {
    const hook = verificationHooks.get(config.verificationHook);
    if (!hook) {
      log.warn("Verification hook not found", {
        runId: entry.runId,
        hook: config.verificationHook,
      });
      return { passed: true, reason: `Hook '${config.verificationHook}' not found, skipping` };
    }

    try {
      const result = await Promise.race([
        hook({
          runId: entry.runId,
          task: entry.task,
          outcome: entry.outcome ?? { status: "ok" },
          entry,
        }),
        new Promise<VerificationResult>((_, reject) =>
          setTimeout(() => reject(new Error("Verification timeout")), timeoutMs),
        ),
      ]);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Verification hook failed", { runId: entry.runId, error: msg });
      return { passed: false, reason: `Hook error: ${msg}` };
    }
  }

  // Built-in verification: check if outcome is success
  if (entry.outcome?.status === "error") {
    return { passed: false, reason: entry.outcome.error ?? "Task ended with error" };
  }

  // Optional prompt-based verification via agent query
  if (config.verificationPrompt) {
    try {
      const verificationResult = await verifyWithAgent(entry, config, timeoutMs);
      return verificationResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Agent verification failed", { runId: entry.runId, error: msg });
      return { passed: false, reason: `Agent verification error: ${msg}` };
    }
  }

  return { passed: true, reason: "Default verification passed" };
}

/**
 * Verify task completion by asking the agent to confirm.
 */
async function verifyWithAgent(
  entry: SubagentRunRecord,
  config: Required<SubagentOrchestrationConfig>,
  timeoutMs: number,
): Promise<VerificationResult> {
  const verificationPrompt = [
    "Please verify that the following task was completed successfully.",
    "",
    "Task:",
    "---",
    entry.task,
    "---",
    "",
    config.verificationPrompt ||
      "Was this task completed successfully? Respond with YES or NO followed by a brief explanation.",
    "",
    "If the task failed or is incomplete, explain what went wrong or what remains to be done.",
  ].join("\n");

  try {
    // Query the child session for verification
    const response = await callGateway<{ reply?: string }>({
      method: "agent.query",
      params: {
        key: entry.childSessionKey,
        prompt: verificationPrompt,
      },
      timeoutMs,
    });

    const reply = response?.reply?.toLowerCase() ?? "";

    // Simple heuristic: check for YES/NO at the start
    if (reply.startsWith("yes") || reply.includes("completed successfully")) {
      return { passed: true, reason: "Agent confirmed completion" };
    }

    if (reply.startsWith("no") || reply.includes("failed") || reply.includes("incomplete")) {
      return { passed: false, reason: `Agent reported: ${response?.reply?.slice(0, 200)}` };
    }

    // Unclear response - treat as passed but log warning
    log.warn("Unclear verification response", {
      runId: entry.runId,
      reply: response?.reply?.slice(0, 100),
    });
    return { passed: true, reason: "Unclear response, defaulting to passed" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Agent query failed: ${msg}`, { cause: err });
  }
}

/**
 * Handle task completion with optional verification and retry logic.
 */
async function handleTaskCompletion(
  entry: SubagentRunRecord,
  orchestrationConfig: Required<SubagentOrchestrationConfig>,
): Promise<void> {
  // Skip verification if task failed (will be handled by retry logic)
  if (entry.outcome?.status === "error") {
    entry.verificationResult = "skipped";
    persistSubagentRuns();
    return;
  }

  // Run verification for successful tasks
  if (orchestrationConfig.verifyCompletion) {
    const verificationResult = await verifyTaskCompletion(entry, orchestrationConfig);

    if (verificationResult.passed) {
      entry.verificationResult = "passed";
      persistSubagentRuns();
      log.info("Task verification passed", {
        runId: entry.runId,
        reason: verificationResult.reason,
      });
      return;
    }

    // Verification failed
    entry.verificationResult = "failed";
    log.warn("Task verification failed", {
      runId: entry.runId,
      reason: verificationResult.reason,
    });

    // Check if we should retry on verification failure
    if (orchestrationConfig.retryOnVerificationFailure) {
      // Convert to error outcome for retry
      entry.outcome = {
        status: "error",
        error: `Verification failed: ${verificationResult.reason}`,
      };
      persistSubagentRuns();

      if (shouldRetryTask(entry, orchestrationConfig)) {
        log.info("Scheduling retry after verification failure", { runId: entry.runId });
        if (!pendingRetries.has(entry.runId)) {
          pendingRetries.add(entry.runId);
          void scheduleTaskRetry(entry, orchestrationConfig).finally(() => {
            pendingRetries.delete(entry.runId);
          });
        }
        return;
      }
    }

    persistSubagentRuns();
    return;
  }

  // No verification configured
  entry.verificationResult = "skipped";
  persistSubagentRuns();
}

function resolveSubagentWaitTimeoutMs(
  cfg: ReturnType<typeof loadConfig>,
  runTimeoutSeconds?: number,
) {
  return resolveAgentTimeoutMs({ cfg, overrideSeconds: runTimeoutSeconds });
}

/**
 * Proceed with cleanup after task completion (and optional verification).
 */
function proceedWithCleanup(runId: string, entry: SubagentRunRecord): void {
  if (!beginSubagentCleanup(runId)) {
    return;
  }
  const requesterOrigin = normalizeDeliveryContext(entry.requesterOrigin);
  void runSubagentAnnounceFlow({
    childSessionKey: entry.childSessionKey,
    childRunId: entry.runId,
    requesterSessionKey: entry.requesterSessionKey,
    requesterOrigin,
    requesterDisplayKey: entry.requesterDisplayKey,
    task: entry.task,
    timeoutMs: 30_000,
    cleanup: entry.cleanup,
    waitForCompletion: false,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    label: entry.label,
    outcome: entry.outcome,
    retryCount: entry.retryCount,
    verificationResult: entry.verificationResult,
  }).then((didAnnounce) => {
    finalizeSubagentCleanup(runId, entry.cleanup, didAnnounce);
  });
}

function startSweeper() {
  if (sweeper) {
    return;
  }
  sweeper = setInterval(() => {
    void sweepSubagentRuns();
  }, 60_000);
  sweeper.unref?.();
}

function stopSweeper() {
  if (!sweeper) {
    return;
  }
  clearInterval(sweeper);
  sweeper = null;
}

async function sweepSubagentRuns() {
  const now = Date.now();
  let mutated = false;
  for (const [runId, entry] of subagentRuns.entries()) {
    if (!entry.archiveAtMs || entry.archiveAtMs > now) {
      continue;
    }
    subagentRuns.delete(runId);
    mutated = true;
    try {
      await callGateway({
        method: "sessions.delete",
        params: { key: entry.childSessionKey, deleteTranscript: true },
        timeoutMs: 10_000,
      });
    } catch {
      // ignore
    }
  }
  if (mutated) {
    persistSubagentRuns();
  }
  if (subagentRuns.size === 0) {
    stopSweeper();
  }
}

function ensureListener() {
  if (listenerStarted) {
    return;
  }
  listenerStarted = true;
  listenerStop = onAgentEvent((evt) => {
    if (!evt || evt.stream !== "lifecycle") {
      return;
    }
    const entry = subagentRuns.get(evt.runId);
    if (!entry) {
      return;
    }
    const phase = evt.data?.phase;
    if (phase === "start") {
      const startedAt = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : undefined;
      if (startedAt) {
        entry.startedAt = startedAt;
        persistSubagentRuns();
      }
      return;
    }
    if (phase !== "end" && phase !== "error") {
      return;
    }
    const endedAt = typeof evt.data?.endedAt === "number" ? evt.data.endedAt : Date.now();
    entry.endedAt = endedAt;
    if (phase === "error") {
      const error = typeof evt.data?.error === "string" ? evt.data.error : undefined;
      entry.outcome = { status: "error", error };
    } else {
      entry.outcome = { status: "ok" };
    }
    persistSubagentRuns();

    // Check if we should retry on failure
    const orchestrationConfig = resolveOrchestrationConfig(loadConfig(), entry.orchestrationConfig);

    if (entry.outcome?.status === "error" && shouldRetryTask(entry, orchestrationConfig)) {
      // Don't cleanup yet - schedule retry instead
      if (!pendingRetries.has(evt.runId)) {
        pendingRetries.add(evt.runId);
        log.info("Task failed, scheduling retry", {
          runId: evt.runId,
          retryCount: entry.retryCount ?? 0,
          maxRetries: orchestrationConfig.maxRetries,
        });
        void scheduleTaskRetry(entry, orchestrationConfig).finally(() => {
          pendingRetries.delete(evt.runId);
        });
      }
      return;
    }

    // Run verification for successful tasks (if configured)
    if (entry.outcome?.status === "ok" && orchestrationConfig.verifyCompletion) {
      if (!pendingVerifications.has(evt.runId)) {
        pendingVerifications.add(evt.runId);
        void handleTaskCompletion(entry, orchestrationConfig)
          .then(() => {
            // Check if verification triggered a retry
            if (entry.outcome?.status === "error") {
              // Retry was scheduled by verification failure, don't cleanup
              return;
            }
            // Proceed with cleanup
            proceedWithCleanup(evt.runId, entry);
          })
          .finally(() => {
            pendingVerifications.delete(evt.runId);
          });
      }
      return;
    }

    if (!beginSubagentCleanup(evt.runId)) {
      return;
    }
    const requesterOrigin = normalizeDeliveryContext(entry.requesterOrigin);
    void runSubagentAnnounceFlow({
      childSessionKey: entry.childSessionKey,
      childRunId: entry.runId,
      requesterSessionKey: entry.requesterSessionKey,
      requesterOrigin,
      requesterDisplayKey: entry.requesterDisplayKey,
      task: entry.task,
      timeoutMs: 30_000,
      cleanup: entry.cleanup,
      waitForCompletion: false,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      label: entry.label,
      outcome: entry.outcome,
      retryCount: entry.retryCount,
      verificationResult: entry.verificationResult,
    }).then((didAnnounce) => {
      finalizeSubagentCleanup(evt.runId, entry.cleanup, didAnnounce);
    });
  });
}

function finalizeSubagentCleanup(runId: string, cleanup: "delete" | "keep", didAnnounce: boolean) {
  const entry = subagentRuns.get(runId);
  if (!entry) {
    return;
  }
  if (cleanup === "delete") {
    subagentRuns.delete(runId);
    persistSubagentRuns();
    return;
  }
  if (!didAnnounce) {
    // Allow retry on the next wake if the announce failed.
    entry.cleanupHandled = false;
    persistSubagentRuns();
    return;
  }
  entry.cleanupCompletedAt = Date.now();
  persistSubagentRuns();
}

function beginSubagentCleanup(runId: string) {
  const entry = subagentRuns.get(runId);
  if (!entry) {
    return false;
  }
  if (entry.cleanupCompletedAt) {
    return false;
  }
  if (entry.cleanupHandled) {
    return false;
  }
  entry.cleanupHandled = true;
  persistSubagentRuns();
  return true;
}

export function registerSubagentRun(params: {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  cleanup: "delete" | "keep";
  label?: string;
  runTimeoutSeconds?: number;
  /** Optional orchestration config override for this specific run. */
  orchestrationConfig?: SubagentOrchestrationConfig;
}) {
  const now = Date.now();
  const cfg = loadConfig();
  const archiveAfterMs = resolveArchiveAfterMs(cfg);
  const archiveAtMs = archiveAfterMs ? now + archiveAfterMs : undefined;
  const waitTimeoutMs = resolveSubagentWaitTimeoutMs(cfg, params.runTimeoutSeconds);
  const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);

  // Resolve orchestration config: param override > config > defaults
  const resolvedOrchestration = resolveOrchestrationConfig(cfg);
  const orchestrationConfig: SubagentOrchestrationConfig = params.orchestrationConfig
    ? { ...resolvedOrchestration, ...params.orchestrationConfig }
    : resolvedOrchestration;

  subagentRuns.set(params.runId, {
    runId: params.runId,
    childSessionKey: params.childSessionKey,
    requesterSessionKey: params.requesterSessionKey,
    requesterOrigin,
    requesterDisplayKey: params.requesterDisplayKey,
    task: params.task,
    cleanup: params.cleanup,
    label: params.label,
    createdAt: now,
    startedAt: now,
    archiveAtMs,
    cleanupHandled: false,
    // Initialize retry tracking
    retryCount: 0,
    maxRetries: orchestrationConfig.maxRetries,
    orchestrationConfig,
  });
  ensureListener();
  persistSubagentRuns();
  if (archiveAfterMs) {
    startSweeper();
  }
  // Wait for subagent completion via gateway RPC (cross-process).
  // The in-process lifecycle listener is a fallback for embedded runs.
  void waitForSubagentCompletion(params.runId, waitTimeoutMs);
}

async function waitForSubagentCompletion(runId: string, waitTimeoutMs: number) {
  try {
    const timeoutMs = Math.max(1, Math.floor(waitTimeoutMs));
    const wait = await callGateway<{
      status?: string;
      startedAt?: number;
      endedAt?: number;
      error?: string;
    }>({
      method: "agent.wait",
      params: {
        runId,
        timeoutMs,
      },
      timeoutMs: timeoutMs + 10_000,
    });
    if (wait?.status !== "ok" && wait?.status !== "error") {
      return;
    }
    const entry = subagentRuns.get(runId);
    if (!entry) {
      return;
    }
    let mutated = false;
    if (typeof wait.startedAt === "number") {
      entry.startedAt = wait.startedAt;
      mutated = true;
    }
    if (typeof wait.endedAt === "number") {
      entry.endedAt = wait.endedAt;
      mutated = true;
    }
    if (!entry.endedAt) {
      entry.endedAt = Date.now();
      mutated = true;
    }
    const waitError = typeof wait.error === "string" ? wait.error : undefined;
    entry.outcome =
      wait.status === "error" ? { status: "error", error: waitError } : { status: "ok" };
    mutated = true;
    if (mutated) {
      persistSubagentRuns();
    }
    if (!beginSubagentCleanup(runId)) {
      return;
    }
    const requesterOrigin = normalizeDeliveryContext(entry.requesterOrigin);
    void runSubagentAnnounceFlow({
      childSessionKey: entry.childSessionKey,
      childRunId: entry.runId,
      requesterSessionKey: entry.requesterSessionKey,
      requesterOrigin,
      requesterDisplayKey: entry.requesterDisplayKey,
      task: entry.task,
      timeoutMs: 30_000,
      cleanup: entry.cleanup,
      waitForCompletion: false,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      label: entry.label,
      outcome: entry.outcome,
      retryCount: entry.retryCount,
      verificationResult: entry.verificationResult,
    }).then((didAnnounce) => {
      finalizeSubagentCleanup(runId, entry.cleanup, didAnnounce);
    });
  } catch {
    // ignore
  }
}

export function resetSubagentRegistryForTests() {
  subagentRuns.clear();
  resumedRuns.clear();
  pendingRetries.clear();
  pendingVerifications.clear();
  verificationHooks.clear();
  stopSweeper();
  restoreAttempted = false;
  if (listenerStop) {
    listenerStop();
    listenerStop = null;
  }
  listenerStarted = false;
  persistSubagentRuns();
}

export function addSubagentRunForTests(entry: SubagentRunRecord) {
  subagentRuns.set(entry.runId, entry);
  persistSubagentRuns();
}

export function releaseSubagentRun(runId: string) {
  const didDelete = subagentRuns.delete(runId);
  if (didDelete) {
    persistSubagentRuns();
  }
  if (subagentRuns.size === 0) {
    stopSweeper();
  }
}

export function listSubagentRunsForRequester(requesterSessionKey: string): SubagentRunRecord[] {
  const key = requesterSessionKey.trim();
  if (!key) {
    return [];
  }
  return [...subagentRuns.values()].filter((entry) => entry.requesterSessionKey === key);
}

export function initSubagentRegistry() {
  restoreSubagentRunsOnce();
}
