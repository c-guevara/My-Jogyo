/**
 * Parallel Queue State Schema for Gyoshu Workers
 *
 * Defines TypeScript interfaces and helper functions for the durable job queue
 * that coordinates parallel worker execution in Gyoshu AUTO mode.
 *
 * Storage Path: `reports/{reportTitle}/queue/{runId}.json`
 *
 * ## Job State Machine:
 * ```
 * PENDING → CLAIMED → DONE
 *                  → FAILED (after maxAttempts or unrecoverable error)
 * ```
 *
 * ## Stale Claim Handling:
 * Jobs that have been CLAIMED but haven't received a heartbeat in `staleClaimMs`
 * are considered abandoned and can be reclaimed by other workers.
 *
 * ## Lock Integration:
 * All queue mutations MUST be performed while holding the queue lock.
 * Use `getQueueLockPath()` from `./lock-paths.ts` and `withLock()` from `./session-lock.ts`.
 *
 * @see lock-paths.ts for queue lock path helpers
 * @see session-lock.ts for lock primitives
 * @module parallel-queue
 */

import * as path from "path";
import { getReportDir, validatePathSegment } from "./paths";

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * Job status state machine: PENDING → CLAIMED → DONE/FAILED
 *
 * - `PENDING`: Job is waiting to be claimed by a worker
 * - `CLAIMED`: Job has been claimed by a worker and is being processed
 * - `DONE`: Job completed successfully
 * - `FAILED`: Job failed after exhausting all retry attempts
 */
export type JobStatus = "PENDING" | "CLAIMED" | "DONE" | "FAILED";

/**
 * Job kinds supported by the queue.
 *
 * Gyoshu-specific kinds:
 * - `jogyo_stage`: A research stage to be executed by Jogyo worker
 * - `baksa_verify`: A verification task to be executed by Baksa worker
 *
 * Generic kinds (used by parallel-manager):
 * - `execute_stage`: Generic stage execution
 * - `verify_stage`: Generic verification task
 * - `generate_report`: Report generation task
 * - `custom`: Custom job type
 */
export type JobKind =
  | "jogyo_stage"
  | "baksa_verify"
  | "execute_stage"
  | "verify_stage"
  | "generate_report"
  | "custom";

// =============================================================================
// INTERFACES
// =============================================================================

/**
 * Payload for a job describing what to execute.
 *
 * @example
 * ```typescript
 * const payload: JobPayload = {
 *   objective: "Load and clean customer data",
 *   code: "import pandas as pd\ndf = pd.read_csv('data.csv')",
 *   context: {
 *     stageNumber: 1,
 *     dependsOn: [],
 *   },
 * };
 * ```
 */
export interface JobPayload {
  /** Human-readable objective description */
  objective: string;

  /** Optional Python code to execute */
  code?: string;

  /** Optional context passed to the worker */
  context?: Record<string, unknown>;
}

/**
 * A single job in the parallel queue.
 *
 * Jobs are the unit of work distributed to parallel workers.
 * Each job tracks its lifecycle from PENDING through DONE/FAILED.
 *
 * @example
 * ```typescript
 * const job: Job = {
 *   jobId: "job-001",
 *   stageId: "S01_load_data",
 *   kind: "jogyo_stage",
 *   status: "PENDING",
 *   attempt: 0,
 *   maxAttempts: 3,
 *   payload: {
 *     objective: "Load customer churn dataset",
 *   },
 * };
 * ```
 */
export interface Job {
  /** Unique identifier for this job (e.g., "job-001") */
  jobId: string;

  /** Stage ID this job belongs to (e.g., "S01_load_data") */
  stageId: string;

  /** Kind of job determining which worker handles it */
  kind: JobKind;

  /** Current status in the job lifecycle */
  status: JobStatus;

  // ─────────────────────────────────────────────────────────────────────────
  // Claiming Info
  // ─────────────────────────────────────────────────────────────────────────

  /** Worker ID that claimed this job (set when status is CLAIMED) */
  claimedBy?: string;

  /** ISO 8601 timestamp when the job was claimed */
  claimedAt?: string;

  /** ISO 8601 timestamp of last heartbeat from the claiming worker */
  heartbeatAt?: string;

  // ─────────────────────────────────────────────────────────────────────────
  // Retry Tracking
  // ─────────────────────────────────────────────────────────────────────────

  /** Current attempt number (0 = not started, 1 = first attempt, etc.) */
  attempt: number;

  /** Maximum number of attempts before marking as FAILED */
  maxAttempts: number;

  // ─────────────────────────────────────────────────────────────────────────
  // Completion Info
  // ─────────────────────────────────────────────────────────────────────────

  /** Result data from successful completion */
  result?: unknown;

  /** Error message if the job failed */
  error?: string;

  /** ISO 8601 timestamp when the job completed (DONE or FAILED) */
  completedAt?: string;

  // ─────────────────────────────────────────────────────────────────────────
  // Job Payload
  // ─────────────────────────────────────────────────────────────────────────

  /** What the job should execute */
  payload?: JobPayload;
}

/**
 * A worker instance tracking.
 *
 * Workers register themselves and send heartbeats to indicate they are alive.
 * Workers that stop heartbeating are considered dead and their jobs can be reclaimed.
 *
 * @example
 * ```typescript
 * const worker: Worker = {
 *   workerId: "worker-001",
 *   sessionId: "ses_abc123",
 *   lastHeartbeat: "2026-01-06T10:30:00Z",
 *   currentJob: "job-001",
 *   capabilities: ["jogyo_stage"],
 * };
 * ```
 */
export interface Worker {
  /** Unique identifier for this worker instance */
  workerId: string;

  /** Research session ID the worker belongs to */
  sessionId: string;

  /** ISO 8601 timestamp of the last heartbeat received */
  lastHeartbeat: string;

  /** Job ID currently being processed (if any) */
  currentJob?: string;

  /** List of job kinds this worker can handle */
  capabilities?: JobKind[];
}

/**
 * Queue configuration parameters.
 *
 * Controls timeouts, retry limits, and heartbeat intervals.
 *
 * @example
 * ```typescript
 * const config: QueueConfig = {
 *   staleClaimMs: 300000,     // 5 minutes
 *   maxJobAttempts: 3,
 *   heartbeatIntervalMs: 30000, // 30 seconds
 * };
 * ```
 */
export interface QueueConfig {
  /**
   * Time in milliseconds after which a claimed job is considered stale.
   * Stale jobs can be reclaimed by other workers.
   * Default: 300000 (5 minutes)
   */
  staleClaimMs: number;

  /**
   * Maximum number of attempts for a job before marking as FAILED.
   * Default: 3
   */
  maxJobAttempts: number;

  /**
   * Interval in milliseconds between worker heartbeats.
   * Workers should send heartbeats more frequently than staleClaimMs.
   * Default: 30000 (30 seconds)
   */
  heartbeatIntervalMs?: number;
}

/**
 * Aggregate status of the parallel queue.
 *
 * - `ACTIVE`: Queue has pending or claimed jobs
 * - `COMPLETED`: All jobs finished successfully
 * - `FAILED`: One or more jobs failed permanently
 */
export type QueueStatus = "ACTIVE" | "COMPLETED" | "FAILED";

/**
 * Complete parallel queue state.
 *
 * This is the root object stored at `reports/{reportTitle}/queue/{runId}.json`.
 * Contains all jobs, workers, and configuration for a research run.
 *
 * @example
 * ```typescript
 * const state: ParallelQueueState = {
 *   reportTitle: "customer-churn-analysis",
 *   runId: "run-001",
 *   createdAt: "2026-01-06T10:00:00Z",
 *   updatedAt: "2026-01-06T10:30:00Z",
 *   jobs: [...],
 *   workers: [...],
 *   config: DEFAULT_QUEUE_CONFIG,
 *   status: "ACTIVE",
 * };
 * ```
 */
export interface ParallelQueueState {
  /** Research report title (used for path resolution) */
  reportTitle: string;

  /** Unique run identifier */
  runId: string;

  /** ISO 8601 timestamp when the queue was created */
  createdAt: string;

  /** ISO 8601 timestamp of last modification */
  updatedAt: string;

  /** Array of all jobs in the queue */
  jobs: Job[];

  /** Array of registered workers */
  workers: Worker[];

  /** Queue configuration parameters */
  config: QueueConfig;

  /** Aggregate status of the queue */
  status: QueueStatus;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Default queue configuration with sensible values.
 *
 * - `staleClaimMs`: 5 minutes (300000ms) - enough time for long-running stages
 * - `maxJobAttempts`: 3 - retry twice before failing permanently
 * - `heartbeatIntervalMs`: 30 seconds (30000ms) - frequent enough to detect failures
 */
export const DEFAULT_QUEUE_CONFIG: QueueConfig = {
  staleClaimMs: 300000, // 5 minutes
  maxJobAttempts: 3,
  heartbeatIntervalMs: 30000, // 30 seconds
};

// =============================================================================
// PATH HELPERS
// =============================================================================

/**
 * Get the path to the queue state file for a given report and run.
 *
 * @param reportTitle - The report/research title (e.g., "customer-churn-analysis")
 * @param runId - The run identifier (e.g., "run-001")
 * @returns Absolute path to `reports/{reportTitle}/queue/{runId}.json`
 *
 * @example
 * ```typescript
 * getQueueStatePath("customer-churn", "run-001");
 * // Returns: "/home/user/my-project/reports/customer-churn/queue/run-001.json"
 * ```
 */
export function getQueueStatePath(reportTitle: string, runId: string): string {
  validatePathSegment(runId, "runId");
  return path.join(getReportDir(reportTitle), "queue", `${runId}.json`);
}

// =============================================================================
// FACTORY FUNCTIONS
// =============================================================================

/**
 * Create an empty queue state with default configuration.
 *
 * Use this to initialize a new queue for a research run.
 *
 * @param reportTitle - The report/research title
 * @param runId - The run identifier
 * @param config - Optional configuration overrides (merged with DEFAULT_QUEUE_CONFIG)
 * @returns A new ParallelQueueState with empty jobs and workers arrays
 *
 * @example
 * ```typescript
 * const queue = createEmptyQueue("customer-churn", "run-001");
 * // {
 * //   reportTitle: "customer-churn",
 * //   runId: "run-001",
 * //   createdAt: "2026-01-06T10:00:00Z",
 * //   updatedAt: "2026-01-06T10:00:00Z",
 * //   jobs: [],
 * //   workers: [],
 * //   config: { staleClaimMs: 300000, maxJobAttempts: 3, heartbeatIntervalMs: 30000 },
 * //   status: "ACTIVE",
 * // }
 *
 * // With custom config:
 * const customQueue = createEmptyQueue("analysis", "run-002", {
 *   staleClaimMs: 600000, // 10 minutes
 *   maxJobAttempts: 5,
 * });
 * ```
 */
export function createEmptyQueue(
  reportTitle: string,
  runId: string,
  config?: Partial<QueueConfig>
): ParallelQueueState {
  const now = new Date().toISOString();

  return {
    reportTitle,
    runId,
    createdAt: now,
    updatedAt: now,
    jobs: [],
    workers: [],
    config: {
      ...DEFAULT_QUEUE_CONFIG,
      ...config,
    },
    status: "ACTIVE",
  };
}

/**
 * Create a new job with default values.
 *
 * @param jobId - Unique job identifier
 * @param stageId - Stage ID this job belongs to
 * @param kind - Kind of job (determines worker type)
 * @param payload - Optional job payload
 * @param maxAttempts - Optional max attempts override (default: 3)
 * @returns A new Job in PENDING status
 *
 * @example
 * ```typescript
 * const job = createJob("job-001", "S01_load_data", "jogyo_stage", {
 *   objective: "Load customer data",
 * });
 * // {
 * //   jobId: "job-001",
 * //   stageId: "S01_load_data",
 * //   kind: "jogyo_stage",
 * //   status: "PENDING",
 * //   attempt: 0,
 * //   maxAttempts: 3,
 * //   payload: { objective: "Load customer data" },
 * // }
 * ```
 */
export function createJob(
  jobId: string,
  stageId: string,
  kind: JobKind,
  payload?: JobPayload,
  maxAttempts: number = DEFAULT_QUEUE_CONFIG.maxJobAttempts
): Job {
  return {
    jobId,
    stageId,
    kind,
    status: "PENDING",
    attempt: 0,
    maxAttempts,
    payload,
  };
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Check if a job's claim is stale (timed out).
 *
 * A claimed job is considered stale if:
 * - It has a heartbeat timestamp AND the time since last heartbeat exceeds staleClaimMs
 * - OR it has no heartbeat but the time since claim exceeds staleClaimMs
 *
 * Only applies to jobs with status "CLAIMED".
 *
 * @param job - The job to check
 * @param config - Queue configuration with staleClaimMs
 * @returns True if the job's claim is stale and can be reclaimed
 *
 * @example
 * ```typescript
 * const job: Job = {
 *   status: "CLAIMED",
 *   claimedAt: "2026-01-06T10:00:00Z",
 *   heartbeatAt: "2026-01-06T10:01:00Z",
 *   // ... other fields
 * };
 * const config = { staleClaimMs: 300000 }; // 5 minutes
 *
 * // If current time is 10:10, heartbeat was 9 minutes ago:
 * isJobStale(job, config); // true
 * ```
 */
export function isJobStale(job: Job, config: QueueConfig): boolean {
  if (job.status !== "CLAIMED") {
    return false;
  }

  const now = Date.now();
  const lastActivity = job.heartbeatAt || job.claimedAt;

  if (!lastActivity) {
    // No timestamp available, cannot determine staleness
    return false;
  }

  const lastActivityTime = new Date(lastActivity).getTime();
  const elapsed = now - lastActivityTime;

  return elapsed >= config.staleClaimMs;
}

/**
 * Get all jobs with a specific status.
 *
 * @param state - The queue state
 * @param status - The status to filter by
 * @returns Array of jobs matching the status
 *
 * @example
 * ```typescript
 * const pendingJobs = getJobsByStatus(state, "PENDING");
 * const claimedJobs = getJobsByStatus(state, "CLAIMED");
 * const failedJobs = getJobsByStatus(state, "FAILED");
 * ```
 */
export function getJobsByStatus(state: ParallelQueueState, status: JobStatus): Job[] {
  return state.jobs.filter((job) => job.status === status);
}

/**
 * Get all active (non-stale) workers.
 *
 * A worker is considered active if its last heartbeat is within staleClaimMs.
 *
 * @param state - The queue state
 * @param config - Queue configuration (optional, defaults to state.config)
 * @returns Array of workers that have sent recent heartbeats
 *
 * @example
 * ```typescript
 * const activeWorkers = getActiveWorkers(state);
 * console.log(`${activeWorkers.length} workers currently active`);
 * ```
 */
export function getActiveWorkers(
  state: ParallelQueueState,
  config?: QueueConfig
): Worker[] {
  const effectiveConfig = config || state.config;
  const now = Date.now();

  return state.workers.filter((worker) => {
    const lastHeartbeat = new Date(worker.lastHeartbeat).getTime();
    const elapsed = now - lastHeartbeat;
    return elapsed < effectiveConfig.staleClaimMs;
  });
}

/**
 * Get stale jobs that can be reclaimed.
 *
 * Returns all CLAIMED jobs whose claims have timed out.
 *
 * @param state - The queue state
 * @returns Array of stale jobs eligible for reclaim
 *
 * @example
 * ```typescript
 * const staleJobs = getStaleJobs(state);
 * for (const job of staleJobs) {
 *   // Reset to PENDING for reclaim
 *   job.status = "PENDING";
 *   job.claimedBy = undefined;
 *   job.claimedAt = undefined;
 *   job.heartbeatAt = undefined;
 * }
 * ```
 */
export function getStaleJobs(state: ParallelQueueState): Job[] {
  return state.jobs.filter((job) => isJobStale(job, state.config));
}

/**
 * Count jobs by status.
 *
 * @param state - The queue state
 * @returns Object with count for each status
 *
 * @example
 * ```typescript
 * const counts = countJobsByStatus(state);
 * // { PENDING: 5, CLAIMED: 2, DONE: 10, FAILED: 1 }
 * ```
 */
export function countJobsByStatus(state: ParallelQueueState): Record<JobStatus, number> {
  const counts: Record<JobStatus, number> = {
    PENDING: 0,
    CLAIMED: 0,
    DONE: 0,
    FAILED: 0,
  };

  for (const job of state.jobs) {
    counts[job.status]++;
  }

  return counts;
}

// =============================================================================
// TYPE GUARDS
// =============================================================================

/**
 * Type guard to check if a value is a valid JobStatus.
 *
 * @param value - The value to check
 * @returns True if value is a valid JobStatus
 *
 * @example
 * ```typescript
 * const status: unknown = "PENDING";
 * if (isJobStatus(status)) {
 *   // status is now typed as JobStatus
 * }
 * ```
 */
export function isJobStatus(value: unknown): value is JobStatus {
  return (
    typeof value === "string" &&
    ["PENDING", "CLAIMED", "DONE", "FAILED"].includes(value)
  );
}

/**
 * Type guard to check if a value is a valid JobKind.
 *
 * @param value - The value to check
 * @returns True if value is a valid JobKind
 *
 * @example
 * ```typescript
 * const kind: unknown = "jogyo_stage";
 * if (isJobKind(kind)) {
 *   // kind is now typed as JobKind
 * }
 * ```
 */
export function isJobKind(value: unknown): value is JobKind {
  return (
    typeof value === "string" &&
    [
      "jogyo_stage",
      "baksa_verify",
      "execute_stage",
      "verify_stage",
      "generate_report",
      "custom",
    ].includes(value)
  );
}

/**
 * Type guard to check if a value is a valid QueueStatus.
 *
 * @param value - The value to check
 * @returns True if value is a valid QueueStatus
 */
export function isQueueStatus(value: unknown): value is QueueStatus {
  return (
    typeof value === "string" &&
    ["ACTIVE", "COMPLETED", "FAILED"].includes(value)
  );
}

/**
 * Type guard to check if an object is a valid Job.
 *
 * Performs structural validation of required fields.
 *
 * @param obj - The object to check
 * @returns True if obj has the shape of a Job
 */
export function isJob(obj: unknown): obj is Job {
  if (typeof obj !== "object" || obj === null) {
    return false;
  }

  const job = obj as Record<string, unknown>;

  return (
    typeof job.jobId === "string" &&
    typeof job.stageId === "string" &&
    isJobKind(job.kind) &&
    isJobStatus(job.status) &&
    typeof job.attempt === "number" &&
    typeof job.maxAttempts === "number"
  );
}

/**
 * Type guard to check if an object is a valid ParallelQueueState.
 *
 * Performs structural validation of required fields.
 *
 * @param obj - The object to check
 * @returns True if obj has the shape of a ParallelQueueState
 */
export function isParallelQueueState(obj: unknown): obj is ParallelQueueState {
  if (typeof obj !== "object" || obj === null) {
    return false;
  }

  const state = obj as Record<string, unknown>;

  return (
    typeof state.reportTitle === "string" &&
    typeof state.runId === "string" &&
    typeof state.createdAt === "string" &&
    typeof state.updatedAt === "string" &&
    Array.isArray(state.jobs) &&
    Array.isArray(state.workers) &&
    typeof state.config === "object" &&
    state.config !== null &&
    isQueueStatus(state.status)
  );
}
