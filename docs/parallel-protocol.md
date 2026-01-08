# Gyoshu Parallel Worker Protocol

> **Version:** 1.0  
> **Status:** Draft  
> **Last Updated:** 2026-01-06

This document defines the parallel worker protocol for Gyoshu research automation. Parallel workers enable increased throughput by running multiple Jogyo execution contexts simultaneously, with results committed atomically to the canonical notebook.

---

## Table of Contents

1. [Overview](#overview)
2. [Worker Output Contract](#worker-output-contract)
3. [Staging Directory Structure](#staging-directory-structure)
4. [Worker Responsibilities](#worker-responsibilities)
5. [Main Session Responsibilities](#main-session-responsibilities)
6. [Barrier/Commit Flow](#barriercommit-flow)
7. [Session ID Format](#session-id-format)
8. [Error Handling and Retry Behavior](#error-handling-and-retry-behavior)
9. [Queue Protocol](#queue-protocol)

---

## Overview

### Purpose

Parallel workers enable Gyoshu to scale research execution horizontally. Instead of a single Jogyo agent executing stages sequentially, multiple worker processes can execute independent stages concurrently.

**Key benefits:**
- **Increased throughput**: Multiple stages execute simultaneously
- **Reduced latency**: Independent work happens in parallel
- **Fault isolation**: Worker failures don't corrupt shared state
- **Best-of-K selection**: Multiple approaches can be compared

### Architecture Context

```
                        User (/gyoshu-auto goal)
                                 |
                                 v
                    +------------------------+
                    |   Gyoshu (Main/Master) |
                    |   - Creates stage plan |
                    |   - Initializes queue  |
                    |   - Waits at barriers  |
                    |   - Commits results    |
                    +------------------------+
                                 |
            +--------------------+--------------------+
            |                    |                    |
            v                    v                    v
    +--------------+     +--------------+     +--------------+
    | Worker 1     |     | Worker 2     |     | Worker K     |
    | (Jogyo)      |     | (Jogyo)      |     | (Jogyo)      |
    | - Claims job |     | - Claims job |     | - Claims job |
    | - Executes   |     | - Executes   |     | - Executes   |
    | - Writes to  |     | - Writes to  |     | - Writes to  |
    |   staging/   |     |   staging/   |     |   staging/   |
    +--------------+     +--------------+     +--------------+
            |                    |                    |
            v                    v                    v
    +-----------------------------------------------------------+
    |                  Staging Directory                         |
    |  reports/{reportTitle}/staging/cycle-{NN}/                |
    |    worker-1/candidate.json                                 |
    |    worker-2/candidate.json                                 |
    |    worker-K/candidate.json                                 |
    +-----------------------------------------------------------+
                                 |
                                 | (barrier: all workers complete)
                                 v
                    +------------------------+
                    |   Gyoshu (Main/Master) |
                    |   - Selects best       |
                    |   - Commits to notebook|
                    |   - Cleans staging     |
                    +------------------------+
                                 |
                                 v
                    +------------------------+
                    |   Canonical Notebook   |
                    |   notebooks/{slug}.ipynb|
                    +------------------------+
```

### Core Invariant

> **CRITICAL**: Workers NEVER write to the canonical notebook. They only write to their staging directory. The main session is solely responsible for committing selected results to the notebook.

This invariant ensures:
- **Atomicity**: Either all selected results commit or none do
- **Isolation**: Worker failures leave the notebook unchanged
- **Consistency**: Only one writer (main session) touches the notebook
- **Selection**: Multiple candidates can be compared before commit

---

## Worker Output Contract

### CandidateResult Schema

Workers MUST write a `candidate.json` file to their staging directory upon completion. This file follows the `CandidateResult` schema:

```typescript
/**
 * Output contract for parallel workers.
 * Workers MUST produce this file at staging/cycle-{NN}/worker-{K}/candidate.json
 */
interface CandidateResult {
  // ===== IDENTIFICATION =====
  
  /** Unique worker identifier (e.g., "w01", "w02") */
  workerId: string;
  
  /** Stage ID being executed (e.g., "S03_train_model") */
  stageId: string;
  
  /** Cycle number this candidate belongs to */
  cycleNumber: number;
  
  // ===== EXECUTION OUTCOME =====
  
  /** Human-readable description of what was attempted */
  objective: string;
  
  /** Whether execution succeeded without errors */
  success: boolean;
  
  /** Exit code if execution failed (0 = success) */
  exitCode?: number;
  
  /** Error message if execution failed */
  errorMessage?: string;
  
  /** Error stack trace if available */
  errorStack?: string;
  
  // ===== EXTRACTED RESULTS =====
  
  /** 
   * Metrics extracted from [METRIC:*] markers.
   * Keys are metric names (e.g., "cv_accuracy_mean"), values are numbers.
   */
  metrics: Record<string, number>;
  
  /** 
   * Finding texts extracted from [FINDING] markers.
   * Each string is the full finding statement.
   */
  findings: string[];
  
  /**
   * Statistical evidence extracted from [STAT:*] markers.
   * Structured for quality gate validation.
   */
  statistics: {
    /** Confidence intervals from [STAT:ci] */
    confidenceIntervals: string[];
    /** Effect sizes from [STAT:effect_size] */
    effectSizes: string[];
    /** P-values from [STAT:p_value] */
    pValues: string[];
  };
  
  /**
   * Relative paths to created artifacts (figures, models, exports).
   * Paths are relative to the worker's staging directory.
   */
  artifacts: string[];
  
  // ===== REPRODUCIBILITY =====
  
  /**
   * Source code of cells executed, in order.
   * Used for committing to the canonical notebook.
   */
  codeExecuted: string[];
  
  /**
   * Cell outputs in Jupyter notebook format.
   * Parallel to codeExecuted array.
   */
  cellOutputs: Array<{
    /** Output type: stream, execute_result, display_data, error */
    output_type: string;
    /** Output content (varies by type) */
    data?: Record<string, unknown>;
    text?: string | string[];
  }[]>;
  
  /**
   * Random seeds used for reproducibility.
   * Keys are library names (e.g., "numpy", "torch"), values are seed values.
   */
  randomSeeds?: Record<string, number>;
  
  /** Known limitations from [LIMITATION] markers */
  limitations: string[];
  
  // ===== TIMING =====
  
  /** ISO 8601 timestamp when execution started */
  startedAt: string;
  
  /** ISO 8601 timestamp when execution completed */
  completedAt: string;
  
  /** Total execution duration in milliseconds */
  durationMs: number;
  
  // ===== QUALITY METRICS =====
  
  /**
   * Self-reported quality score (0-100).
   * Based on evidence completeness, not external verification.
   */
  qualityScore?: number;
  
  /**
   * Quality gate violations detected.
   * E.g., ["FINDING_NO_CI", "ML_NO_BASELINE"]
   */
  qualityViolations?: string[];
}
```

### JSON Schema (For Validation)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "CandidateResult",
  "description": "Output contract for Gyoshu parallel workers",
  "type": "object",
  "required": [
    "workerId",
    "stageId",
    "cycleNumber",
    "objective",
    "success",
    "metrics",
    "findings",
    "statistics",
    "artifacts",
    "codeExecuted",
    "cellOutputs",
    "limitations",
    "startedAt",
    "completedAt",
    "durationMs"
  ],
  "properties": {
    "workerId": {
      "type": "string",
      "pattern": "^w[0-9]{2}$",
      "description": "Worker identifier (e.g., 'w01')"
    },
    "stageId": {
      "type": "string",
      "pattern": "^S[0-9]{2}_[a-z]+_[a-z_]+$",
      "description": "Stage ID following naming convention"
    },
    "cycleNumber": {
      "type": "integer",
      "minimum": 1,
      "description": "Execution cycle number"
    },
    "objective": {
      "type": "string",
      "minLength": 10,
      "description": "Human-readable objective"
    },
    "success": {
      "type": "boolean",
      "description": "Whether execution succeeded"
    },
    "exitCode": {
      "type": "integer",
      "description": "Exit code (0 = success)"
    },
    "errorMessage": {
      "type": "string",
      "description": "Error message if failed"
    },
    "metrics": {
      "type": "object",
      "additionalProperties": { "type": "number" },
      "description": "Extracted [METRIC:*] values"
    },
    "findings": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Extracted [FINDING] texts"
    },
    "statistics": {
      "type": "object",
      "properties": {
        "confidenceIntervals": {
          "type": "array",
          "items": { "type": "string" }
        },
        "effectSizes": {
          "type": "array",
          "items": { "type": "string" }
        },
        "pValues": {
          "type": "array",
          "items": { "type": "string" }
        }
      },
      "required": ["confidenceIntervals", "effectSizes", "pValues"]
    },
    "artifacts": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Paths to created files"
    },
    "codeExecuted": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Cell source code"
    },
    "cellOutputs": {
      "type": "array",
      "items": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "output_type": { "type": "string" }
          },
          "required": ["output_type"]
        }
      }
    },
    "limitations": {
      "type": "array",
      "items": { "type": "string" }
    },
    "startedAt": {
      "type": "string",
      "format": "date-time"
    },
    "completedAt": {
      "type": "string",
      "format": "date-time"
    },
    "durationMs": {
      "type": "integer",
      "minimum": 0
    },
    "qualityScore": {
      "type": "integer",
      "minimum": 0,
      "maximum": 100
    },
    "qualityViolations": {
      "type": "array",
      "items": { "type": "string" }
    }
  }
}
```

### Example CandidateResult

```json
{
  "workerId": "w01",
  "stageId": "S03_train_model",
  "cycleNumber": 2,
  "objective": "Train Random Forest classifier on wine quality dataset",
  "success": true,
  "metrics": {
    "cv_accuracy_mean": 0.87,
    "cv_accuracy_std": 0.03,
    "baseline_accuracy": 0.42,
    "improvement_over_baseline": 0.45
  },
  "findings": [
    "Random Forest achieves 87% accuracy, outperforming baseline (42%) by 45 percentage points",
    "Top predictors: alcohol (0.23), volatile_acidity (0.18), sulphates (0.15)"
  ],
  "statistics": {
    "confidenceIntervals": ["95% CI [0.84, 0.90]"],
    "effectSizes": ["Cohen's d = 1.8 (large)"],
    "pValues": ["p < 0.001"]
  },
  "artifacts": [
    "figures/confusion_matrix.png",
    "figures/feature_importance.png",
    "models/rf_model.pkl"
  ],
  "codeExecuted": [
    "from sklearn.ensemble import RandomForestClassifier\nfrom sklearn.model_selection import cross_val_score\n...",
    "print(f'[METRIC:cv_accuracy_mean] {scores.mean():.3f}')\n..."
  ],
  "cellOutputs": [
    [
      {
        "output_type": "stream",
        "name": "stdout",
        "text": "[METRIC:cv_accuracy_mean] 0.870\n[METRIC:cv_accuracy_std] 0.030\n"
      }
    ],
    [
      {
        "output_type": "display_data",
        "data": {
          "image/png": "base64encodeddata..."
        }
      }
    ]
  ],
  "randomSeeds": {
    "numpy": 42,
    "sklearn": 42
  },
  "limitations": [
    "Dataset limited to Portuguese wines; may not generalize to other regions",
    "Class imbalance not addressed (quality 5-6 dominate)"
  ],
  "startedAt": "2026-01-06T10:30:00Z",
  "completedAt": "2026-01-06T10:32:45Z",
  "durationMs": 165000,
  "qualityScore": 95,
  "qualityViolations": []
}
```

---

## Staging Directory Structure

### Directory Layout

```
reports/{reportTitle}/
├── staging/                           # Temporary staging area
│   └── cycle-{NN}/                    # Execution cycle (01, 02, ...)
│       ├── queue.json                 # Shared job queue state
│       ├── worker-{K}/                # Per-worker isolation
│       │   ├── candidate.json         # Worker output contract
│       │   ├── output.log             # Full execution output (stdout/stderr)
│       │   ├── figures/               # Generated visualizations
│       │   │   ├── confusion_matrix.png
│       │   │   └── feature_importance.png
│       │   ├── models/                # Trained models
│       │   │   └── rf_model.pkl
│       │   └── exports/               # Data exports
│       │       └── predictions.csv
│       └── worker-{K}/                # (repeated for each worker)
│           └── ...
├── figures/                           # Canonical figures (committed)
├── models/                            # Canonical models (committed)
└── checkpoints/                       # Checkpoint data
```

### Staging Lifecycle

```
1. INITIALIZE
   Main session creates: staging/cycle-{NN}/queue.json

2. CLAIM
   Worker claims job, creates: staging/cycle-{NN}/worker-{K}/

3. EXECUTE
   Worker writes outputs to its staging directory

4. COMPLETE
   Worker writes: staging/cycle-{NN}/worker-{K}/candidate.json

5. BARRIER
   Main session waits for all workers to complete

6. COMMIT
   Main session:
   - Selects best candidate(s)
   - Copies artifacts to canonical locations
   - Appends cells to notebook
   - Deletes staging/cycle-{NN}/
```

### Path Conventions

| Path Component | Format | Example |
|----------------|--------|---------|
| Report Title | Lowercase with hyphens | `wine-quality` |
| Cycle Number | Two digits, zero-padded | `cycle-01`, `cycle-02` |
| Worker ID | `worker-` + two digits | `worker-01`, `worker-02` |
| Figures | Descriptive snake_case | `confusion_matrix.png` |
| Models | Descriptive snake_case | `rf_model.pkl` |

---

## Worker Responsibilities

### 1. Claim Job from Queue

Workers MUST atomically claim a job before executing:

```typescript
// Pseudocode for job claiming
async function claimJob(queuePath: string, workerId: string): Promise<Job | null> {
  const lock = await acquireLock(queuePath);
  try {
    const queue = await readQueue(queuePath);
    const pendingJob = queue.jobs.find(j => j.status === 'pending');
    if (!pendingJob) return null;
    
    pendingJob.status = 'claimed';
    pendingJob.claimedBy = workerId;
    pendingJob.claimedAt = new Date().toISOString();
    
    await writeQueue(queuePath, queue);
    return pendingJob;
  } finally {
    await releaseLock(lock);
  }
}
```

### 2. Execute Assigned Stage

Workers execute the stage using the Python REPL:

- Set random seeds for reproducibility
- Load inputs from specified paths
- Execute stage code
- Capture all `[MARKER]` outputs
- Save artifacts to staging directory

### 3. Write CandidateResult

Upon completion (success or failure), workers MUST write `candidate.json`:

```typescript
// Worker completion
async function completeJob(
  stagingDir: string, 
  workerId: string,
  result: CandidateResult
): Promise<void> {
  const candidatePath = path.join(stagingDir, `worker-${workerId}`, 'candidate.json');
  await writeFile(candidatePath, JSON.stringify(result, null, 2));
}
```

### 4. Report Completion to Queue

Workers update the queue to signal completion:

```typescript
// Update queue status
async function reportCompletion(
  queuePath: string,
  workerId: string,
  success: boolean
): Promise<void> {
  const lock = await acquireLock(queuePath);
  try {
    const queue = await readQueue(queuePath);
    const job = queue.jobs.find(j => j.claimedBy === workerId);
    if (job) {
      job.status = success ? 'completed' : 'failed';
      job.completedAt = new Date().toISOString();
    }
    await writeQueue(queuePath, queue);
  } finally {
    await releaseLock(lock);
  }
}
```

### 5. NEVER Write to Canonical Notebook

Workers MUST NOT:
- Write to `notebooks/{slug}.ipynb`
- Modify `reports/{reportTitle}/figures/` (canonical)
- Modify `reports/{reportTitle}/models/` (canonical)
- Delete or modify other workers' staging directories

---

## Main Session Responsibilities

### 1. Initialize Queue with Jobs

Main session creates the job queue before spawning workers:

```typescript
interface ParallelJob {
  /** Unique job identifier */
  jobId: string;
  
  /** Stage to execute */
  stageId: string;
  
  /** Stage envelope with goal, inputs, outputs */
  envelope: StageEnvelope;
  
  /** Current job status */
  status: 'pending' | 'claimed' | 'completed' | 'failed' | 'timeout';
  
  /** Worker that claimed this job */
  claimedBy?: string;
  
  /** ISO timestamp when claimed */
  claimedAt?: string;
  
  /** ISO timestamp when completed */
  completedAt?: string;
}

interface ParallelQueue {
  /** Queue schema version */
  version: 1;
  
  /** Report title this queue belongs to */
  reportTitle: string;
  
  /** Run identifier */
  runId: string;
  
  /** Execution cycle number */
  cycleNumber: number;
  
  /** All jobs in this queue */
  jobs: ParallelJob[];
  
  /** Queue created timestamp */
  createdAt: string;
  
  /** Expected number of workers */
  workerCount: number;
  
  /** Barrier status */
  barrierStatus: 'open' | 'closed';
}
```

### 2. Wait at Barrier for All Jobs

Main session polls until all jobs reach a terminal state:

```typescript
async function waitAtBarrier(
  queuePath: string,
  timeoutMs: number = 600000 // 10 minutes
): Promise<BarrierResult> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    const queue = await readQueue(queuePath);
    
    const pendingOrClaimed = queue.jobs.filter(
      j => j.status === 'pending' || j.status === 'claimed'
    );
    
    if (pendingOrClaimed.length === 0) {
      return {
        success: true,
        completed: queue.jobs.filter(j => j.status === 'completed'),
        failed: queue.jobs.filter(j => j.status === 'failed'),
      };
    }
    
    await sleep(1000); // Poll every second
  }
  
  // Timeout: mark remaining jobs as timed out
  return { success: false, timedOut: true };
}
```

### 3. Select Best Candidate(s)

Main session evaluates candidates and selects the best:

```typescript
interface SelectionCriteria {
  /** Metric to maximize (e.g., "cv_accuracy_mean") */
  primaryMetric?: string;
  
  /** Minimum quality score required */
  minQualityScore?: number;
  
  /** Require no quality violations */
  requireNoViolations?: boolean;
  
  /** Custom ranking function */
  rankFn?: (candidates: CandidateResult[]) => CandidateResult[];
}

async function selectBestCandidate(
  stagingDir: string,
  criteria: SelectionCriteria
): Promise<CandidateResult | null> {
  const candidates = await loadAllCandidates(stagingDir);
  
  // Filter to successful candidates
  let eligible = candidates.filter(c => c.success);
  
  // Apply quality gate
  if (criteria.minQualityScore) {
    eligible = eligible.filter(c => (c.qualityScore ?? 0) >= criteria.minQualityScore);
  }
  
  // Apply violation filter
  if (criteria.requireNoViolations) {
    eligible = eligible.filter(c => (c.qualityViolations?.length ?? 0) === 0);
  }
  
  if (eligible.length === 0) return null;
  
  // Rank by primary metric
  if (criteria.primaryMetric) {
    eligible.sort((a, b) => 
      (b.metrics[criteria.primaryMetric!] ?? 0) - 
      (a.metrics[criteria.primaryMetric!] ?? 0)
    );
  }
  
  return eligible[0];
}
```

### 4. Commit Selected Results to Notebook

Main session atomically commits selected candidate to notebook:

```typescript
async function commitCandidate(
  notebookPath: string,
  candidate: CandidateResult,
  stagingDir: string
): Promise<void> {
  // 1. Copy artifacts to canonical locations
  for (const artifact of candidate.artifacts) {
    const srcPath = path.join(stagingDir, `worker-${candidate.workerId}`, artifact);
    const destPath = path.join(getCanonicalDir(notebookPath), artifact);
    await copyFile(srcPath, destPath);
  }
  
  // 2. Append code cells to notebook
  const notebook = await loadNotebook(notebookPath);
  for (let i = 0; i < candidate.codeExecuted.length; i++) {
    notebook.cells.push({
      cell_type: 'code',
      source: candidate.codeExecuted[i].split('\n'),
      outputs: candidate.cellOutputs[i] || [],
      metadata: {
        'gyoshu-worker': candidate.workerId,
        'gyoshu-stage': candidate.stageId,
      },
      execution_count: notebook.cells.length + 1,
    });
  }
  await saveNotebook(notebookPath, notebook);
}
```

### 5. Clean Up Staging Directories

After successful commit, main session cleans staging:

```typescript
async function cleanupStaging(stagingDir: string): Promise<void> {
  await rm(stagingDir, { recursive: true, force: true });
}
```

---

## Barrier/Commit Flow

### Sequence Diagram

```
Main Session          Queue              Worker 1           Worker 2
     |                  |                    |                  |
     |--[1] CREATE----->|                    |                  |
     |    queue.json    |                    |                  |
     |                  |                    |                  |
     |--[2] SPAWN-------|------------------>|                  |
     |--[2] SPAWN-------|----------------------------------------->|
     |                  |                    |                  |
     |                  |<--[3] CLAIM--------|                  |
     |                  |<--[3] CLAIM--------------------------|
     |                  |                    |                  |
     |                  |    [4] EXECUTE     |    [4] EXECUTE   |
     |                  |    (stage code)    |    (stage code)  |
     |                  |                    |                  |
     |                  |<--[5] COMPLETE-----|                  |
     |                  |    candidate.json  |                  |
     |                  |                    |                  |
     |                  |<--[5] COMPLETE------------------------|
     |                  |                    |  candidate.json  |
     |                  |                    |                  |
     |<-[6] BARRIER-----|                    |                  |
     |   (poll until    |                    |                  |
     |    all complete) |                    |                  |
     |                  |                    |                  |
     |--[7] SELECT----->|                    |                  |
     |    best          |                    |                  |
     |    candidate     |                    |                  |
     |                  |                    |                  |
     |--[8] COMMIT------|                    |                  |
     |    to notebook   |                    |                  |
     |                  |                    |                  |
     |--[9] CLEANUP-----|                    |                  |
     |    staging/      |                    |                  |
     |                  |                    |                  |
```

### State Machine

```
                      +---------+
                      | PENDING |
                      +----+----+
                           |
                    [Worker claims]
                           |
                           v
                      +---------+
                      | CLAIMED |
                      +----+----+
                           |
              +------------+------------+
              |                         |
        [Success]                  [Failure]
              |                         |
              v                         v
         +----------+            +---------+
         |COMPLETED |            | FAILED  |
         +----+-----+            +----+----+
              |                       |
              +-----------+-----------+
                          |
                    [Barrier wait]
                          |
                          v
                   +-----------+
                   | COMMITTED |
                   +-----------+
```

### Timing Guarantees

| Phase | Timeout | Default | Notes |
|-------|---------|---------|-------|
| Job Claim | 30s | 30s | Worker must claim within this window |
| Stage Execution | Varies | 240s | From stage envelope `maxDurationSec` |
| Barrier Wait | 10 min | 600s | Max time to wait for all workers |
| Commit | 60s | 60s | Max time to write notebook |
| Cleanup | 30s | 30s | Max time to delete staging |

---

## Session ID Format

### Session ID Components

Gyoshu uses structured session IDs for parallel execution:

```
{role}-{reportTitle}-{runId}-{workerSpec}
```

| Component | Format | Example |
|-----------|--------|---------|
| Role | Fixed prefix | `gyoshu` |
| Report Title | Lowercase, hyphens | `wine-quality` |
| Run ID | `run-` + timestamp | `run-20260106-143022` |
| Worker Spec | Role suffix | `master`, `w01-jogyo`, `w02-jogyo` |

### Session ID Examples

| Session Type | Session ID | Purpose |
|--------------|------------|---------|
| Main/Master | `gyoshu-wine-quality-run-20260106-143022-master` | Orchestrator session |
| Worker 1 | `gyoshu-wine-quality-run-20260106-143022-w01-jogyo` | First worker |
| Worker 2 | `gyoshu-wine-quality-run-20260106-143022-w02-jogyo` | Second worker |
| Worker K | `gyoshu-wine-quality-run-20260106-143022-w{KK}-jogyo` | K-th worker |

### Session ID Validation

```typescript
const SESSION_ID_PATTERN = /^gyoshu-[a-z0-9-]+-run-\d{8}-\d{6}-(master|w\d{2}-jogyo)$/;

function validateSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

function parseSessionId(sessionId: string): {
  reportTitle: string;
  runId: string;
  isMaster: boolean;
  workerId?: string;
} {
  const parts = sessionId.split('-');
  // Parse and return components...
}
```

### Runtime Directory Structure

Session runtime data follows this structure (per `src/lib/paths.ts`):

```
$XDG_RUNTIME_DIR/gyoshu/           # Linux with XDG
~/Library/Caches/gyoshu/runtime/   # macOS
~/.cache/gyoshu/runtime/           # Linux fallback

└── {shortSessionId}/              # Hashed to 12 chars
    ├── bridge.sock                # Python REPL socket
    ├── session.lock               # Session lock file
    └── bridge_meta.json           # Runtime state
```

---

## Error Handling and Retry Behavior

### Error Categories

| Category | Behavior | Example |
|----------|----------|---------|
| **Transient** | Automatic retry | Network timeout, temp file error |
| **Permanent** | Mark failed, no retry | Invalid input, missing dependency |
| **Timeout** | Emergency checkpoint, mark failed | Stage exceeded `maxDurationSec` |
| **Fatal** | Abort cycle, escalate | Queue corruption, disk full |

### Worker Error Handling

```typescript
async function executeWithErrorHandling(
  job: ParallelJob,
  workerId: string
): Promise<CandidateResult> {
  const startTime = Date.now();
  
  try {
    const result = await executeStage(job.envelope);
    return {
      ...result,
      success: true,
      workerId,
      stageId: job.stageId,
    };
  } catch (error) {
    return {
      workerId,
      stageId: job.stageId,
      objective: job.envelope.goal,
      success: false,
      exitCode: 1,
      errorMessage: error.message,
      errorStack: error.stack,
      metrics: {},
      findings: [],
      statistics: { confidenceIntervals: [], effectSizes: [], pValues: [] },
      artifacts: [],
      codeExecuted: [],
      cellOutputs: [],
      limitations: [],
      startedAt: new Date(startTime).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
    };
  }
}
```

### Retry Policy

```typescript
interface RetryPolicy {
  /** Maximum retry attempts */
  maxRetries: number;
  
  /** Base delay between retries (ms) */
  baseDelayMs: number;
  
  /** Exponential backoff multiplier */
  backoffMultiplier: number;
  
  /** Maximum delay cap (ms) */
  maxDelayMs: number;
  
  /** Errors that should not be retried */
  permanentErrors: string[];
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: 30000,
  permanentErrors: [
    'ModuleNotFoundError',
    'FileNotFoundError',
    'PermissionError',
  ],
};
```

### Fallback Behavior

When all workers fail:

1. **Main session** marks cycle as failed
2. **Checkpoint** is created if any progress was made
3. **User** is notified with failure summary
4. **Next cycle** can retry with different strategy (if `retryable: true`)

---

## Queue Protocol

### Queue File Format

The queue is stored as `staging/cycle-{NN}/queue.json`:

```typescript
interface ParallelQueue {
  /** Schema version for forward compatibility */
  version: 1;
  
  /** Research report this queue belongs to */
  reportTitle: string;
  
  /** Unique run identifier */
  runId: string;
  
  /** Cycle number (1, 2, 3, ...) */
  cycleNumber: number;
  
  /** All jobs in this cycle */
  jobs: ParallelJob[];
  
  /** ISO timestamp when queue was created */
  createdAt: string;
  
  /** Number of workers expected to process this queue */
  workerCount: number;
  
  /** Barrier status: 'open' = accepting claims, 'closed' = barrier reached */
  barrierStatus: 'open' | 'closed';
}
```

### Queue Lock Protocol

All queue operations MUST use file locking:

```typescript
// Lock acquisition with timeout
async function acquireQueueLock(
  queuePath: string,
  timeoutMs: number = 5000
): Promise<Lock> {
  const lockPath = `${queuePath}.lock`;
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    try {
      // Exclusive lock with O_EXCL
      const fd = await open(lockPath, 'wx');
      return { fd, path: lockPath };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      await sleep(50); // Back off and retry
    }
  }
  
  throw new Error(`Queue lock timeout after ${timeoutMs}ms`);
}
```

### Queue Operations

| Operation | Actor | Lock Required | Description |
|-----------|-------|---------------|-------------|
| CREATE | Main | Yes | Initialize queue with jobs |
| CLAIM | Worker | Yes | Atomically claim pending job |
| COMPLETE | Worker | Yes | Mark job as completed/failed |
| POLL | Main | No (read-only) | Check job statuses |
| CLOSE | Main | Yes | Mark barrier as closed |

---

## References

- [Stage Protocol](./stage-protocol.md) - Stage envelope and naming conventions
- [AGENTS.md](../AGENTS.md) - Agent roles and marker reference
- [Checkpoint System](./stage-protocol.md#checkpoint-trust-levels) - Checkpoint/resume capability
- `src/lib/paths.ts` - Path resolution utilities
- `src/lib/parallel-queue.ts` - Queue implementation (to be created)
- `src/tool/parallel-manager.ts` - Parallel manager tool (to be created)
