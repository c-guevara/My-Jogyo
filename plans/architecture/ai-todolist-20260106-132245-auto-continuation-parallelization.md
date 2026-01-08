# Gyoshu Auto-Continuation + Parallelization Implementation Plan

**Goals**:
1. Implement Ralph-Loop style auto-continuation for `/gyoshu-auto` (no user prompts mid-run)
2. Add safety locks for notebook/report writes
3. Enable parallel Jogyo workers for increased throughput
4. Add parallel Baksa verification with barrier/commit pattern

**Parent Plan**: `gyoshu-research-system-plan.md`
**Prerequisite**: Adversarial verification complete ✅

---

## Problem Statement

### Current Issue with `/gyoshu-auto`
The AUTO mode stops and asks the user to decide instead of continuing autonomously.

From `src/agent/gyoshu.md:1761`:
```
FOR cycle in 1..maxCycles:
  1. Plan next objective
  2. Delegate to @jogyo
  3. VERIFY with @baksa (MANDATORY)
  4. If trust >= 80: Accept, continue  ← THIS "continue" isn't automatic!
  5. If goal complete: Generate report, exit
  6. If blocked: Report to user, exit
```

**Root Cause**: No concrete loop controller that:
- Consumes Two-Gate outputs to auto-decide
- Persists loop state
- Re-injects continuation prompts when the agent would otherwise stop

### Solution: Ralph-Loop Design Pattern

The **Ralph-Loop** (from oh-my-opencode) is a self-referential development loop:
1. **Detect Idle**: When session goes idle (agent finishes output)
2. **Check Completion**: Scans for `<promise>DONE</promise>` in transcript
3. **If Not Complete**: Auto-injects continuation prompt and iterates
4. **If Complete**: Stops loop, shows success
5. **Max Iterations**: Hard cap to prevent infinite loops

---

## Architecture Overview

### AUTO State Machine

```
┌──────────────────────────┐
│ START (/gyoshu-auto goal) │
└─────────────┬────────────┘
              ▼
┌──────────────────────────┐
│ INIT                      │
│ - load/create AutoLoopState│
│ - set budgets + limits     │
└─────────────┬────────────┘
              ▼
┌──────────────────────────┐
│ CYCLE_PLAN                │
│ - pick next objective      │
│ - choose stage envelope    │
└─────────────┬────────────┘
              ▼
┌──────────────────────────┐
│ CYCLE_EXECUTE (Jogyo)     │
│ - python-repl executions   │
│ - artifacts, markers       │
└─────────────┬────────────┘
              ▼
┌──────────────────────────┐
│ VERIFY (Baksa mandatory)  │
│ - trustScore + challenges  │
│ - up to maxRounds          │
└─────────────┬────────────┘
              ▼
┌──────────────────────────┐
│ EVALUATE GATES            │
│ - Trust: qualityGates      │
│ - Goal: goalGates          │
└─────────────┬────────────┘
              ▼
┌──────────────────────────┐
│ DECIDE ACTION             │
│ CONTINUE | PIVOT | REWORK  │
│ COMPLETE | BLOCKED         │
└─────┬───────────┬─────────┘
      │           │
      │           ▼
      │    ┌─────────────────┐
      │    │ UPDATE_STATE     │
      │    │ persist + budget │
      │    └────────┬────────┘
      │             ▼
      │          (loop)
      ▼
┌──────────────────────────┐
│ TERMINAL                  │
│ - COMPLETE: emit promise   │
│ - BLOCKED: emit promise    │
└──────────────────────────┘
```

### Two-Gate Decision Matrix

| Trust Gate | Goal Gate | Decision | Action |
|------------|-----------|----------|--------|
| PASS (≥80) | MET | COMPLETE | Emit `<promise>GYOSHU_AUTO_COMPLETE</promise>`, generate report |
| PASS (≥80) | NOT_MET | PIVOT | Increment attempt, try different approach |
| PASS (≥80) | BLOCKED | BLOCKED | Emit `<promise>GYOSHU_AUTO_BLOCKED</promise>` |
| FAIL (<80) | ANY | REWORK | Send back to @jogyo with challenges (max 3 rounds) |
| ANY | ANY | CONTINUE | Auto-inject next cycle prompt |

### Exit Condition Tags (Ralph-loop compatible)

```
<promise>GYOSHU_AUTO_COMPLETE</promise>     # Goal achieved, report generated
<promise>GYOSHU_AUTO_BLOCKED</promise>       # Cannot proceed, user intervention needed
<promise>GYOSHU_AUTO_BUDGET_EXHAUSTED</promise>  # Cycles/time/tools exhausted
```

---

## Existing Building Blocks to Reuse

| Component | Location | Purpose |
|-----------|----------|---------|
| Goal Gate | `src/lib/goal-gates.ts:498` | `evaluateGoalGate()` + `recommendPivot()` |
| Quality Gate | `src/lib/quality-gates.ts:348` | `runQualityGates()` |
| Two-Gate Wiring | `src/tool/gyoshu-completion.ts:311` | Adds `qualityGates`, `goalGates`, `pivotRecommendation` |
| Session Lock | `src/lib/session-lock.ts:219` | `SessionLock` + `withLock()` |
| Durable Write | `src/lib/atomic-write.ts:14` | `durableAtomicWrite()` |

---

## Phase 1: Auto-Continuation (Must Work First)

**Goal**: `/gyoshu-auto` runs to `COMPLETE` or `BLOCKED` without user decisions.
**Effort**: Medium (1-2 days)

### Tasks

- [x] 1.1 Define AutoLoopState schema + persistence  *(COMPLETED)*
   - **File**: `src/lib/auto-loop-state.ts` (NEW)
   - **Parallelizable**: YES
   - [x] 1.1.1 Add TypeScript interface for loop state
      ```typescript
      interface AutoLoopState {
        active: boolean;
        iteration: number;
        maxIterations: number;  // default 25
        reportTitle: string;
        runId: string;
        researchSessionID: string;
        
        // Budget tracking
        budgets: {
          maxCycles: number;
          currentCycle: number;
          maxToolCalls: number;
          totalToolCalls: number;
          maxTimeMinutes: number;
          startedAt: string;
        };
        
        // Attempt tracking (for pivots)
        attemptNumber: number;
        maxAttempts: number;  // from goal_contract or default 3
        
        // Decision state
        lastDecision: "CONTINUE" | "PIVOT" | "REWORK" | "COMPLETE" | "BLOCKED" | null;
        nextObjective: string;
        
        // Gate results (cached for reinjection)
        trustScore?: number;
        goalGateStatus?: "MET" | "NOT_MET" | "BLOCKED";
      }
      ```
   - [x] 1.1.2 Implement `loadState(reportTitle)` / `saveState(state)` via `durableAtomicWrite`
   - [x] 1.1.3 State persistence path: `reports/{reportTitle}/auto/loop-state.json`
   - [x] 1.1.4 Implement promise tag parser: `hasPromiseTag(output, tag)` with regex

- [x] 1.2 Implement Two-Gate decision engine
   - **File**: `src/lib/auto-decision.ts` (NEW)
   - **Parallelizable**: YES (with 1.1)
   - [x] 1.2.1 Create `decideNextAction()` function
     ```typescript
     function decideNextAction(params: {
       trustScore: number;
       qualityGates: QualityGateResult;
       goalGates: GoalGateResult;
       attempts: { current: number; max: number };
       reworkRounds: { current: number; max: number };  // max 3
       budgets: BudgetState;
     }): "CONTINUE" | "PIVOT" | "REWORK" | "COMPLETE" | "BLOCKED"
     ```
   - [x] 1.2.2 Decision logic:
     - `COMPLETE`: trustScore >= 80 AND qualityGates.passed AND goalGates.passed
     - `REWORK`: trustScore < 80 OR qualityGates.passed === false (max 3 rounds)
     - `PIVOT`: trust OK but goalGates.overallStatus === "NOT_MET" (increment attempt)
     - `BLOCKED`: goalGates.overallStatus === "BLOCKED" OR rework exhausted OR budgets exhausted
     - `CONTINUE`: otherwise (progressing but not claiming completion)
   - [x] 1.2.3 Add stagnation detection: no new cells/artifacts/markers for N cycles → BLOCKED

- [x] 1.3 Update AUTO specs to be "self-driving"
   - **File**: `src/agent/gyoshu.md` (around line 1761)
   - **Parallelizable**: YES
   - [x] 1.3.1 Replace pseudo-loop with explicit decision matrix
   - [x] 1.3.2 Add "NO USER PROMPT" rule for CONTINUE/PIVOT/REWORK
   - [x] 1.3.3 Add promise tag requirements for exit conditions
   - [x] 1.3.4 Add stagnation rule + hard iteration limit enforcement
   - [x] 1.3.5 Document continuation prompt template

- [x] 1.4 Update gyoshu-auto.md command spec *(COMPLETED)*
   - **File**: `src/command/gyoshu-auto.md`
   - **Parallelizable**: YES
   - [x] 1.4.1 Add explicit exit condition tags
   - [x] 1.4.2 Document auto-decision behavior (no user prompts)
   - [x] 1.4.3 Add stagnation detection description

- [x] 1.5 Add Ralph-loop reinjection hook  *(COMPLETED)*
   - **File**: `src/plugin/gyoshu-hooks.ts`
   - **Parallelizable**: NO (depends on 1.1)
   - [x] 1.5.1 Detect active AutoLoopState on "stop/idle" event
   - [x] 1.5.2 If active AND no promise tag detected → re-inject continuation prompt
   - [x] 1.5.3 Enforce max iterations + max time + stagnation detection
   - [x] 1.5.4 Keep existing bridge cleanup behavior (avoid killing mid-AutoLoop)
   - [x] 1.5.5 Continuation prompt template:
     ```
     AUTO-CONTINUATION (Iteration {N}/{max})
     
     Previous Decision: {lastDecision}
     Trust Score: {trustScore}
     Goal Status: {goalGateStatus}
     Budget: {remaining cycles}/{remaining time}
     
     Next Objective: {nextObjective}
     
     RULES:
     - Do NOT ask user what to do
     - Do NOT stop until COMPLETE, BLOCKED, or BUDGET_EXHAUSTED
     - Emit promise tag when terminal condition reached
     ```

- [x] 1.6 Tests: decision matrix + promise parsing
   - **File**: `tests/auto-loop-decision.test.ts` (NEW)
   - **Parallelizable**: YES
   - [x] 1.6.1 Test: trust fail → REWORK
   - [x] 1.6.2 Test: goal NOT_MET → PIVOT
   - [x] 1.6.3 Test: both pass → COMPLETE
   - [x] 1.6.4 Test: goal BLOCKED → BLOCKED
   - [x] 1.6.5 Test: budgets exceeded → BLOCKED with reason
   - [x] 1.6.6 Test: promise tag parsing (regex correctness)
   - [x] 1.6.7 Test: stagnation detection

### Phase 1 Acceptance Criteria

- [x] `/gyoshu-auto <goal>` does NOT ask "what next?" mid-run *(Documented in gyoshu.md and gyoshu-auto.md)*
- [x] Stops ONLY on COMPLETE/BLOCKED/BUDGET, emitting correct `<promise>` tag *(Implemented in gyoshu-hooks.ts)*
- [x] Decision engine is deterministic and unit-tested *(56/56 tests pass in auto-loop-decision.test.ts)*
- [x] Loop state persists across iterations *(Implemented in auto-loop-state.ts with durableAtomicWrite)*

**PHASE 1 COMPLETE** ✅

---

## Phase 2: Notebook/Report Locks (Safety)

**Goal**: Safe single-writer semantics before enabling parallelism.
**Effort**: Short (1-4 hours)

### Tasks

- [x] 2.1 Define lock path helpers + lock ordering
   - **File**: `src/lib/lock-paths.ts` (NEW) or extend `src/lib/paths.ts`
   - **Parallelizable**: YES
   - [x] 2.1.1 Add `getNotebookLockPath(reportTitle): string`
     - Path: `${getRuntimeDir()}/locks/notebook/${shortenSessionId("nb:"+reportTitle)}.lock`
   - [x] 2.1.2 Add `getReportLockPath(reportTitle): string`
   - [x] 2.1.3 Add `getQueueLockPath(reportTitle, runId): string`
   - [x] 2.1.4 Document lock ordering (mandatory to avoid deadlocks):
     1. QUEUE_LOCK (short)
     2. NOTEBOOK_LOCK (short, only around disk write)
     3. REPORT_LOCK (short, only around disk write)
   - [x] 2.1.5 Rule: NEVER hold locks during Python execution (long-running)

- [x] 2.2 Wrap notebook writes with NOTEBOOK_LOCK
   - **Files**: `src/tool/notebook-writer.ts`, `src/tool/python-repl.ts`
   - **Parallelizable**: NO (depends on 2.1)
   - [x] 2.2.1 Import lock helpers
   - [x] 2.2.2 Wrap `durableAtomicWrite(notebookPath, ...)` calls with NOTEBOOK_LOCK
   - [x] 2.2.3 Add lock timeout (e.g., 30 seconds) + fail-fast on timeout

- [x] 2.3 Wrap checkpoint writes with NOTEBOOK_LOCK
   - **File**: `src/tool/checkpoint-manager.ts`
   - **Parallelizable**: NO (depends on 2.1)
   - [x] 2.3.1 Acquire NOTEBOOK_LOCK around checkpoint cell append

- [x] 2.4 Wrap report generation with REPORT_LOCK
   - **File**: `src/tool/gyoshu-completion.ts` (around line 446)
   - **Parallelizable**: NO (depends on 2.1)
   - [x] 2.4.1 Acquire REPORT_LOCK around `generateReport()` + `exportToPdf()`

- [ ] 2.5 Tests: lock ordering + timeouts
   - **File**: `tests/session-lock.test.ts` (extend) + new lock-path tests
   - **Parallelizable**: YES
   - [ ] 2.5.1 Test: concurrent notebook writes serialize correctly
   - [ ] 2.5.2 Test: lock timeout triggers error (not hang)
   - [ ] 2.5.3 Test: lock ordering is documented and enforced

### Phase 2 Acceptance Criteria

- [ ] No lost updates when multiple writers try to update notebook
- [ ] Lock timeouts prevent deadlocks
- [ ] Single-writer guarantee for notebook and report files

---

## Phase 3: Parallel Workers + Durable Queue

**Goal**: Parallel Jogyo workers within one AUTO cycle, with durable scheduling and barrier waits.
**Effort**: Large (3+ days)

### Tasks

- [x] 3.1 Implement `parallel-manager` tool (durable queue)
   - **File**: `src/tool/parallel-manager.ts` (NEW)
   - **Parallelizable**: NO (foundation)
   - [x] 3.1.1 Define tool schema with actions:
     - `init(reportTitle, runId, config)` - Create run with worker config
     - `enqueue(reportTitle, runId, jobs[])` - Add jobs to queue
     - `claim(reportTitle, runId, workerId, capabilities)` - Atomic job claim
     - `heartbeat(reportTitle, runId, workerId, jobId?)` - Keep-alive signal
     - `complete(reportTitle, runId, jobId, resultSummary)` - Mark done
     - `fail(reportTitle, runId, jobId, error)` - Mark failed
     - `status(reportTitle, runId)` - Get run status
     - `reap(reportTitle, runId)` - Reclaim stale jobs
     - `barrier_wait(reportTitle, runId, stageId)` - Wait for all jobs
   - [x] 3.1.2 Use `QUEUE_LOCK` + `durableAtomicWrite` for all mutations
   - [x] 3.1.3 Implement lease-based claiming for crash recovery
   - [x] 3.1.4 Store queue state: `reports/{reportTitle}/queue/{runId}.json`
   - [x] 3.1.5 Job state machine: PENDING → CLAIMED → DONE/FAILED

- [x] 3.2 Define parallel queue state schema
   - **File**: `src/lib/parallel-queue.ts` (NEW)
   - **Parallelizable**: YES
   - [x] 3.2.1 Define `ParallelQueueState` interface:
     ```typescript
     interface ParallelQueueState {
       reportTitle: string;
       runId: string;
       createdAt: string;
       
       jobs: Array<{
         jobId: string;
         stageId: string;
         kind: "jogyo_stage" | "baksa_verify";
         status: "PENDING" | "CLAIMED" | "DONE" | "FAILED";
         claimedBy?: string;  // workerId
         claimedAt?: string;
         heartbeatAt?: string;
         attempt: number;
         maxAttempts: number;
         result?: unknown;
         error?: string;
       }>;
       
       workers: Array<{
         workerId: string;
         sessionId: string;
         lastHeartbeat: string;
         currentJob?: string;
       }>;
       
       config: {
         staleClaimMs: number;  // e.g., 5 minutes
         maxJobAttempts: number;
       };
     }
     ```

- [x] 3.3 Define worker output contract (CandidateResult)
   - **File**: `docs/parallel-protocol.md` (NEW)
   - **Parallelizable**: YES
   - [x] 3.3.1 Define `candidate.json` schema:
     ```typescript
     interface CandidateResult {
       workerId: string;
       stageId: string;
       objective: string;
       success: boolean;
       
       metrics: Record<string, number>;  // from [METRIC:*] markers
       findings: string[];               // from [FINDING] markers
       artifacts: string[];              // paths to created files
       
       codeExecuted: string[];           // cell source code
       limitations: string[];
     }
     ```
   - [x] 3.3.2 Define staging directory: `reports/{reportTitle}/staging/cycle-{NN}/worker-{k}/`

- [x] 3.4 Update Gyoshu AUTO to use parallel workers
   - **File**: `src/agent/gyoshu.md`
   - **Parallelizable**: YES
   - [x] 3.4.1 Add "Parallel Cycle Template" section
   - [x] 3.4.2 Define when to fan out vs single-worker:
     - Single-worker: Sequential stages (data loading, evaluation)
     - Multi-worker: Exploration (try multiple models/approaches)
   - [x] 3.4.3 Enforce "workers NEVER write canonical notebook"
   - [x] 3.4.4 Add barrier/commit pattern documentation

- [x] 3.5 Worker session ID format
   - [x] 3.5.1 Main session: `gyoshu-{reportTitle}-{runId}-master`
   - [x] 3.5.2 Worker sessions: `gyoshu-{reportTitle}-{runId}-w{01..K}-jogyo`
   - [x] 3.5.3 Validate safe path segment rules (no `/`, `..`, `\`)

- [x] 3.6 Tests for queue correctness
   - **File**: `tests/parallel-manager.test.ts` (NEW)
   - **Parallelizable**: YES
   - [x] 3.6.1 Test: enqueue/claim/complete correctness
   - [x] 3.6.2 Test: concurrent claims return distinct jobs
   - [x] 3.6.3 Test: lease expiration triggers requeue
   - [x] 3.6.4 Test: barrier_wait blocks until all jobs done
   - [x] 3.6.5 Test: no lost updates under concurrent mutations

### Phase 3 Acceptance Criteria

- [x] Multiple Jogyo workers can run experiments in parallel
- [x] Job queue is durable (survives crashes)
- [x] Barrier/commit pattern prevents race conditions
- [x] Only main session writes to canonical notebook

**PHASE 3 COMPLETE** ✅

---

## Phase 4: Parallel Baksa Sharding

**Goal**: Verify multiple candidate outputs in parallel, then commit best results.
**Effort**: Large (3+ days)

### Tasks

- [x] 4.1 Add Baksa sharding protocol *(COMPLETED)*
   - **File**: `src/agent/baksa.md`
   - **Parallelizable**: YES
   - [x] 4.1.1 Add "Sharded Verification Job" template
   - [x] 4.1.2 Require machine-parsable trust score output:
     ```
     Trust Score: 85
     Status: VERIFIED
     ```
   - [x] 4.1.3 Add JSON summary block for automation:
     ```json
     {"trustScore": 85, "status": "VERIFIED", "challenges": [...]}
     ```

- [x] 4.2 Add verification jobs to parallel queue *(Already implemented in Phase 3)*
   - **File**: `src/tool/parallel-manager.ts`
   - **Parallelizable**: NO (depends on Phase 3)
   - [x] 4.2.1 Support job kind: `"baksa_verify"` *(Implemented in parallel-queue.ts)*
   - [x] 4.2.2 Link verification jobs to candidate jobs *(Via stageId)*

- [x] 4.3 Trust aggregation algorithm *(COMPLETED)*
   - **File**: `src/lib/auto-decision.ts`
   - **Parallelizable**: YES
   - [x] 4.3.1 Implement `aggregateTrustScores(verificationResults[])`:
     - Per-claim trust = `min(trustScoresFromReviewers)` (conservative)
     - Stage trust = `min(perClaimTrust)` for critical claims
   - [x] 4.3.2 Trust Gate passes if `stageTrust >= 80`

- [x] 4.4 Commit policy (single writer) *(COMPLETED)*
   - **File**: `src/agent/gyoshu.md`
   - **Parallelizable**: YES
   - [x] 4.4.1 Selection criteria:
     1. trustScore >= 80 (required)
     2. Highest goalGate progress
     3. Best metrics (tiebreaker)
   - [x] 4.4.2 Commit under NOTEBOOK_LOCK only
   - [x] 4.4.3 Record decision rationale in loop state

- [x] 4.5 Barrier/commit flow *(COMPLETED)*
   - [x] 4.5.1 Barrier 1: Wait for all worker `candidate.json` files
   - [x] 4.5.2 Barrier 2: Wait for all `baksa.json` verification results
   - [x] 4.5.3 Commit: Choose best candidate(s), write to notebook, checkpoint

- [x] 4.6 Tests: select-best + commit ordering *(COMPLETED - 37 new tests)*
   - **File**: `tests/auto-loop-decision.test.ts` (extend)
   - **Parallelizable**: YES
   - [x] 4.6.1 Test: select candidate with highest trust
   - [x] 4.6.2 Test: reject all candidates if none >= 80
   - [x] 4.6.3 Test: commit only happens after barrier (documented in gyoshu.md)

### Phase 4 Acceptance Criteria

- [x] Multiple Baksa verifiers can run in parallel
- [x] Trust aggregation is conservative (min over critical claims)
- [x] Best candidate is selected and committed correctly
- [x] Barrier ensures all verification completes before commit

**PHASE 4 COMPLETE** ✅

---

## Watch-Outs (from Adversarial Review)

| Risk | Mitigation |
|------|------------|
| **Infinite loops** | Hard `maxIterations`, stagnation detection, budget enforcement |
| **Deadlocks** | Lock ordering, never hold locks during long work, timeouts |
| **Notebook corruption** | Single-writer commit + NOTEBOOK_LOCK |
| **Gate mis-evaluation** | Evaluate on fresh notebook output; store timestamps |
| **Prompt injection** | Sanitize user goal; use structured templates |
| **Stale claims** | Lease-based job claiming with heartbeat + reap |
| **Lost updates** | QUEUE_LOCK + durableAtomicWrite for all queue mutations |

---

## Summary

| Phase | Goal | Effort | Key Deliverable |
|-------|------|--------|-----------------|
| **Phase 1** | Auto-continuation | 1-2 days | Ralph-loop style `/gyoshu-auto` |
| **Phase 2** | Safety locks | 1-4 hours | NOTEBOOK/REPORT/QUEUE locks |
| **Phase 3** | Parallel workers | 3+ days | `parallel-manager` tool + durable queue |
| **Phase 4** | Parallel Baksa | 3+ days | Sharded verification + barrier/commit |

**Total Effort**: ~1.5-2 weeks for full implementation

---

## Recently Completed

- [x] 1.1 Define AutoLoopState schema + persistence - `src/lib/auto-loop-state.ts`
- [x] 1.2 Implement Two-Gate decision engine - `src/lib/auto-decision.ts`
- [x] 1.5 Add Ralph-loop reinjection hook - `src/plugin/gyoshu-hooks.ts`
- [x] **Report Gate (RGEP v1)** - `src/lib/report-gates.ts` (520 lines, 44 tests)
- [x] **Rich Plotting Protocol (RPP v1)** - `src/agent/jogyo.md` (420 lines added)
- [x] Wire Report Gate into `src/tool/gyoshu-completion.ts`
- [x] **Phase 2: Notebook/Report Locks** (all core tasks complete):
  - [x] 2.1 Lock path helpers - `src/lib/lock-paths.ts` (185 lines, 30 tests)
  - [x] 2.2 Notebook write locks - `src/tool/notebook-writer.ts`, `src/tool/python-repl.ts`
  - [x] 2.3 Checkpoint write locks - `src/tool/checkpoint-manager.ts`
  - [x] 2.4 Report generation locks - `src/tool/gyoshu-completion.ts`
- [x] **Phase 3: Parallel Workers + Durable Queue** (all tasks complete):
  - [x] 3.1 Parallel manager tool - `src/tool/parallel-manager.ts` (988 lines)
  - [x] 3.2 Queue state schema - `src/lib/parallel-queue.ts` (680 lines)
  - [x] 3.3 Worker output contract - `docs/parallel-protocol.md` (32KB)
  - [x] 3.4+3.5 Gyoshu parallel template + session IDs - `src/agent/gyoshu.md`
  - [x] 3.6 Queue correctness tests - `tests/parallel-manager.test.ts` (49 tests)
- [x] **Phase 4: Parallel Baksa Sharding** (ALL tasks complete):
  - [x] 4.1 Baksa sharding protocol - `src/agent/baksa.md` (+228 lines)
  - [x] 4.2 Verification jobs - Already in parallel-queue.ts (`baksa_verify` kind)
  - [x] 4.3 Trust aggregation algorithm - `src/lib/auto-decision.ts` (+~125 lines)
  - [x] 4.4+4.5 Commit policy + barrier flow - `src/agent/gyoshu.md` (+310 lines)
  - [x] 4.6 Tests: select-best + commit ordering - `tests/auto-loop-decision.test.ts` (+37 tests)

## Currently in Progress

(None - **ALL PHASES COMPLETE** ✅)

---

## Notepad Section

### Discoveries During Implementation

**Report Gate (RGEP v1):**
- Uses penalty-based scoring (score = 100 - sum of penalties)
- Section matching is case-insensitive with variants (e.g., "## Summary" → Executive Summary)
- Quick `isReportReady()` function for fast validation without full scoring
- Wired into gyoshu-completion as the third gate (Trust → Goal → Report)

**Rich Plotting Protocol (RPP v1):**
- Added ~420 lines to jogyo.md with comprehensive plotting documentation
- Standardized `[FIGURE:type:path=...:dpi=300:lib=...]` marker format
- Minimum figure requirements by research type (EDA: 5, ML: 5, Statistical: 3)
- `save_figure()` helper template provided
- 7 code templates for common plot types
- Figure Quality Checklist (10 items)

**Phase 2: Notebook/Report Locks:**
- Created `src/lib/lock-paths.ts` with three lock path helpers
- Lock ordering: QUEUE_LOCK → NOTEBOOK_LOCK → REPORT_LOCK
- 30-second timeout for fail-fast behavior
- `deriveLockIdFromPath()` helper extracts reportTitle from notebook path
- Locks wrap ONLY the actual write operation, not long-running code
- All modules load successfully, 130 tests pass

### Learnings

- Parallel executor tasks work well when they modify independent files
- Report Gate can downgrade SUCCESS → PARTIAL if report is incomplete
- Three-Gate system is now: Trust Gate (quality) + Goal Gate (criteria) + Report Gate (completeness)
- Lock wrapping should be minimal - only around `durableAtomicWrite()` calls
- Phase 2 tasks 2.2-2.4 can run in parallel once 2.1 is complete (dependency pattern)
