/**
 * Auto-Decision Engine - Two-Gate decision logic for autonomous research.
 *
 * This module implements the decision engine for the `/gyoshu-auto` command,
 * determining the next action based on Trust Gate and Goal Gate results.
 *
 * Decision Matrix:
 * | Trust Gate | Goal Gate | Decision | Action |
 * |------------|-----------|----------|--------|
 * | PASS (>=80) | MET | COMPLETE | Research complete, generate report |
 * | PASS (>=80) | NOT_MET | PIVOT | Try different approach |
 * | PASS (>=80) | BLOCKED | BLOCKED | Cannot proceed, user intervention |
 * | FAIL (<80) | ANY | REWORK | Improve evidence quality |
 * | ANY | ANY | CONTINUE | Continue progressing |
 *
 * Additional Triggers for BLOCKED:
 * - Rework rounds exhausted (max 3)
 * - Goal attempts exhausted (max from goal_contract)
 * - Budget exhausted (cycles, time, or tool calls)
 * - Stagnation detected (no progress for N cycles)
 *
 * @module auto-decision
 */

import type { GoalGateResult } from "./goal-gates";
import type { QualityGateResult } from "./quality-gates";

// =============================================================================
// TYPES AND INTERFACES
// =============================================================================

/**
 * The 6 possible decisions from the auto-decision engine.
 *
 * - COMPLETE: Both gates pass, research goal achieved
 * - PIVOT: Trust OK but goal not met, try different approach
 * - REWORK: Evidence quality issues, improve and retry
 * - BLOCKED: Cannot proceed, user intervention required
 * - BUDGET_EXHAUSTED: Resource limits reached (cycles, time, tool calls)
 * - CONTINUE: Still in progress, not claiming completion yet
 */
export type AutoDecision = "COMPLETE" | "PIVOT" | "REWORK" | "BLOCKED" | "BUDGET_EXHAUSTED" | "CONTINUE";

/**
 * Trust threshold for passing the Trust Gate.
 */
export const TRUST_THRESHOLD = 80;

/**
 * Default maximum rework rounds before giving up.
 */
export const DEFAULT_MAX_REWORK_ROUNDS = 3;

/**
 * Default maximum goal attempts before BLOCKED.
 */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Default cycles without progress before stagnation detection.
 */
export const DEFAULT_STAGNATION_CYCLES = 3;

/**
 * Budget state for tracking resource consumption.
 */
export interface BudgetState {
  /** Maximum allowed cycles */
  maxCycles: number;
  /** Current cycle number (1-indexed) */
  currentCycle: number;
  /** Maximum allowed tool calls */
  maxToolCalls: number;
  /** Total tool calls made so far */
  totalToolCalls: number;
  /** Maximum allowed time in minutes */
  maxTimeMinutes: number;
  /** ISO timestamp when auto-loop started */
  startedAt: string;
}

/**
 * State for tracking stagnation detection.
 */
export interface StagnationState {
  /** Number of consecutive cycles without new cells */
  cyclesWithoutNewCells: number;
  /** Number of consecutive cycles without new artifacts */
  cyclesWithoutNewArtifacts: number;
  /** Number of consecutive cycles without new markers */
  cyclesWithoutNewMarkers: number;
  /** Last cell count observed */
  lastCellCount: number;
  /** Last artifact count observed */
  lastArtifactCount: number;
  /** Last marker count observed */
  lastMarkerCount: number;
}

/**
 * Parameters for the decision engine.
 */
export interface DecisionParams {
  /** Trust score from Baksa verification (0-100) */
  trustScore: number;

  /** Quality gate result (statistical evidence quality) */
  qualityGates: QualityGateResult;

  /** Goal gate result (acceptance criteria status) */
  goalGates: GoalGateResult;

  /** Attempt tracking for pivots */
  attempts: {
    /** Current attempt number (1-indexed) */
    current: number;
    /** Maximum attempts allowed (from goal_contract or default 3) */
    max: number;
  };

  /** Rework round tracking */
  reworkRounds: {
    /** Current rework round (0 = first attempt, 1 = first rework, etc.) */
    current: number;
    /** Maximum rework rounds allowed (default 3) */
    max: number;
  };

  /** Budget state for resource tracking */
  budgets: BudgetState;

  /** Optional stagnation state for detecting no progress */
  stagnation?: StagnationState;

  /** Stagnation threshold (cycles without progress to trigger BLOCKED) */
  stagnationThreshold?: number;
}

/**
 * Reason for a specific decision.
 */
export type DecisionReason =
  | "TRUST_AND_GOAL_PASS"
  | "TRUST_PASS_GOAL_NOT_MET"
  | "TRUST_PASS_GOAL_BLOCKED"
  | "TRUST_FAIL"
  | "QUALITY_FAIL"
  | "REWORK_EXHAUSTED"
  | "ATTEMPTS_EXHAUSTED"
  | "CYCLES_EXHAUSTED"
  | "TIME_EXHAUSTED"
  | "TOOL_CALLS_EXHAUSTED"
  | "STAGNATION_DETECTED"
  | "IN_PROGRESS";

/**
 * Result from the decision engine.
 */
export interface DecisionResult {
  /** The decision to take */
  decision: AutoDecision;

  /** Human-readable reason for the decision */
  reason: DecisionReason;

  /** Detailed message explaining the decision */
  message: string;

  /** List of blockers (for BLOCKED decisions) */
  blockers?: string[];

  /** Suggestions for next steps (for PIVOT/REWORK) */
  suggestions?: string[];

  /** Whether this is a terminal decision (COMPLETE or BLOCKED) */
  isTerminal: boolean;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Check if budgets are exhausted.
 *
 * @param budgets - Current budget state
 * @returns Object with exhausted flag and reason
 */
export function checkBudgetExhaustion(budgets: BudgetState): {
  exhausted: boolean;
  reason: DecisionReason | null;
  message: string | null;
} {
  // Check cycles
  if (budgets.currentCycle >= budgets.maxCycles) {
    return {
      exhausted: true,
      reason: "CYCLES_EXHAUSTED",
      message: `Maximum cycles reached (${budgets.currentCycle}/${budgets.maxCycles})`,
    };
  }

  // Check tool calls
  if (budgets.totalToolCalls >= budgets.maxToolCalls) {
    return {
      exhausted: true,
      reason: "TOOL_CALLS_EXHAUSTED",
      message: `Maximum tool calls reached (${budgets.totalToolCalls}/${budgets.maxToolCalls})`,
    };
  }

  // Check time
  const startTime = new Date(budgets.startedAt).getTime();
  const now = Date.now();
  const elapsedMinutes = (now - startTime) / 1000 / 60;

  if (elapsedMinutes >= budgets.maxTimeMinutes) {
    return {
      exhausted: true,
      reason: "TIME_EXHAUSTED",
      message: `Maximum time reached (${Math.round(elapsedMinutes)}/${budgets.maxTimeMinutes} minutes)`,
    };
  }

  return { exhausted: false, reason: null, message: null };
}

/**
 * Detect stagnation (no progress for N cycles).
 *
 * Stagnation is detected when ALL of the following are true for N consecutive cycles:
 * - No new notebook cells added
 * - No new artifacts created
 * - No new markers produced
 *
 * @param stagnation - Current stagnation state
 * @param threshold - Number of cycles without progress to trigger stagnation
 * @returns Whether stagnation is detected
 *
 * @example
 * ```typescript
 * const stagnation = {
 *   cyclesWithoutNewCells: 3,
 *   cyclesWithoutNewArtifacts: 3,
 *   cyclesWithoutNewMarkers: 3,
 *   lastCellCount: 10,
 *   lastArtifactCount: 2,
 *   lastMarkerCount: 5,
 * };
 * const isStagnated = detectStagnation(stagnation, 3);
 * // isStagnated === true (all metrics stagnant for 3 cycles)
 * ```
 */
export function detectStagnation(
  stagnation: StagnationState,
  threshold: number = DEFAULT_STAGNATION_CYCLES
): boolean {
  return (
    stagnation.cyclesWithoutNewCells >= threshold &&
    stagnation.cyclesWithoutNewArtifacts >= threshold &&
    stagnation.cyclesWithoutNewMarkers >= threshold
  );
}

/**
 * Update stagnation state based on new observations.
 *
 * Call this at the end of each cycle to track progress.
 *
 * @param current - Current stagnation state
 * @param newCellCount - Current total cell count
 * @param newArtifactCount - Current total artifact count
 * @param newMarkerCount - Current total marker count
 * @returns Updated stagnation state
 *
 * @example
 * ```typescript
 * const updated = updateStagnationState(
 *   currentState,
 *   15,  // new cell count
 *   3,   // new artifact count
 *   8    // new marker count
 * );
 * ```
 */
export function updateStagnationState(
  current: StagnationState,
  newCellCount: number,
  newArtifactCount: number,
  newMarkerCount: number
): StagnationState {
  return {
    cyclesWithoutNewCells:
      newCellCount > current.lastCellCount
        ? 0
        : current.cyclesWithoutNewCells + 1,
    cyclesWithoutNewArtifacts:
      newArtifactCount > current.lastArtifactCount
        ? 0
        : current.cyclesWithoutNewArtifacts + 1,
    cyclesWithoutNewMarkers:
      newMarkerCount > current.lastMarkerCount
        ? 0
        : current.cyclesWithoutNewMarkers + 1,
    lastCellCount: newCellCount,
    lastArtifactCount: newArtifactCount,
    lastMarkerCount: newMarkerCount,
  };
}

/**
 * Create initial stagnation state.
 *
 * @param cellCount - Initial cell count
 * @param artifactCount - Initial artifact count
 * @param markerCount - Initial marker count
 * @returns Initial stagnation state with zero counters
 */
export function createInitialStagnationState(
  cellCount: number = 0,
  artifactCount: number = 0,
  markerCount: number = 0
): StagnationState {
  return {
    cyclesWithoutNewCells: 0,
    cyclesWithoutNewArtifacts: 0,
    cyclesWithoutNewMarkers: 0,
    lastCellCount: cellCount,
    lastArtifactCount: artifactCount,
    lastMarkerCount: markerCount,
  };
}

// =============================================================================
// MAIN DECISION FUNCTION
// =============================================================================

/**
 * Decide the next action based on Two-Gate results.
 *
 * This is the core decision engine for autonomous research. It evaluates:
 * 1. Trust Gate (Baksa verification) - Is the evidence trustworthy?
 * 2. Goal Gate (acceptance criteria) - Is the goal achieved?
 * 3. Budget constraints - Are we within limits?
 * 4. Stagnation - Are we making progress?
 *
 * The function is pure (no side effects) and deterministic.
 *
 * @param params - Decision parameters including gate results and state
 * @returns Decision result with action, reason, and details
 *
 * @example
 * ```typescript
 * const result = decideNextAction({
 *   trustScore: 85,
 *   qualityGates: { passed: true, score: 100, violations: [], ... },
 *   goalGates: { passed: true, overallStatus: "MET", ... },
 *   attempts: { current: 1, max: 3 },
 *   reworkRounds: { current: 0, max: 3 },
 *   budgets: { maxCycles: 10, currentCycle: 2, ... },
 * });
 *
 * if (result.decision === "COMPLETE") {
 *   console.log("Research complete! Generating report...");
 * }
 * ```
 */
export function decideNextAction(params: DecisionParams): DecisionResult {
  const {
    trustScore,
    qualityGates,
    goalGates,
    attempts,
    reworkRounds,
    budgets,
    stagnation,
    stagnationThreshold = DEFAULT_STAGNATION_CYCLES,
  } = params;

  // ---------------------------------------------------------------------------
  // Priority 1: Check for budget exhaustion (always check first)
  // ---------------------------------------------------------------------------
  const budgetCheck = checkBudgetExhaustion(budgets);
  if (budgetCheck.exhausted) {
    return {
      decision: "BUDGET_EXHAUSTED",
      reason: budgetCheck.reason!,
      message: budgetCheck.message!,
      blockers: [budgetCheck.message!],
      isTerminal: true,
    };
  }

  // ---------------------------------------------------------------------------
  // Priority 2: Check for stagnation
  // ---------------------------------------------------------------------------
  if (stagnation && detectStagnation(stagnation, stagnationThreshold)) {
    return {
      decision: "BLOCKED",
      reason: "STAGNATION_DETECTED",
      message: `No progress detected for ${stagnationThreshold} consecutive cycles`,
      blockers: [
        `No new cells for ${stagnation.cyclesWithoutNewCells} cycles`,
        `No new artifacts for ${stagnation.cyclesWithoutNewArtifacts} cycles`,
        `No new markers for ${stagnation.cyclesWithoutNewMarkers} cycles`,
      ],
      isTerminal: true,
    };
  }

  // ---------------------------------------------------------------------------
  // Priority 3: Check rework exhaustion
  // ---------------------------------------------------------------------------
  if (reworkRounds.current >= reworkRounds.max) {
    return {
      decision: "BLOCKED",
      reason: "REWORK_EXHAUSTED",
      message: `Maximum rework rounds exhausted (${reworkRounds.current}/${reworkRounds.max})`,
      blockers: [
        `Failed to achieve trust score >= ${TRUST_THRESHOLD} after ${reworkRounds.max} rework attempts`,
      ],
      isTerminal: true,
    };
  }

  // ---------------------------------------------------------------------------
  // Priority 4: Check goal attempts exhaustion
  // ---------------------------------------------------------------------------
  if (attempts.current >= attempts.max) {
    return {
      decision: "BLOCKED",
      reason: "ATTEMPTS_EXHAUSTED",
      message: `Maximum goal attempts exhausted (${attempts.current}/${attempts.max})`,
      blockers: [
        `Failed to meet goal criteria after ${attempts.max} attempts`,
      ],
      isTerminal: true,
    };
  }

  // ---------------------------------------------------------------------------
  // Priority 5: Evaluate Trust Gate
  // ---------------------------------------------------------------------------
  const trustPassed = trustScore >= TRUST_THRESHOLD;
  const qualityPassed = qualityGates.passed;

  // If trust fails OR quality fails, check goal gate for BLOCKED status
  // Per spec: Trust FAIL + Goal BLOCKED = BLOCKED (not REWORK)
  if (!trustPassed || !qualityPassed) {
    // Special case: If goal is fundamentally BLOCKED, don't rework - escalate
    if (goalGates.overallStatus === "BLOCKED") {
      return {
        decision: "BLOCKED",
        reason: "TRUST_PASS_GOAL_BLOCKED",
        message: "Goal cannot be achieved with current approach",
        blockers: [
          ...(goalGates.blockers || ["Goal gate returned BLOCKED status"]),
          `Trust score ${trustScore} < ${TRUST_THRESHOLD}`,
        ],
        isTerminal: true,
      };
    }

    const issues: string[] = [];
    const suggestions: string[] = [];

    if (!trustPassed) {
      issues.push(`Trust score ${trustScore} < ${TRUST_THRESHOLD}`);
      suggestions.push("Address Baksa's challenges to improve trust score");
    }

    if (!qualityPassed) {
      issues.push(`Quality score ${qualityGates.score}/100`);
      for (const v of qualityGates.violations) {
        suggestions.push(v.message);
      }
    }

    return {
      decision: "REWORK",
      reason: !trustPassed ? "TRUST_FAIL" : "QUALITY_FAIL",
      message: `Evidence quality issues: ${issues.join("; ")}`,
      suggestions,
      isTerminal: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Priority 6: Trust passed - Evaluate Goal Gate
  // ---------------------------------------------------------------------------
  switch (goalGates.overallStatus) {
    case "MET":
    case "NO_CONTRACT":
      // Both gates pass - SUCCESS!
      return {
        decision: "COMPLETE",
        reason: "TRUST_AND_GOAL_PASS",
        message: `Research complete: Trust score ${trustScore}, all ${goalGates.totalCount} criteria met`,
        isTerminal: true,
      };

    case "NOT_MET":
      // Trust OK but goal not achieved - PIVOT to new approach
      const failedCriteria = goalGates.criteriaResults
        .filter((r) => r.status !== "MET")
        .map((r) => r.message);

      return {
        decision: "PIVOT",
        reason: "TRUST_PASS_GOAL_NOT_MET",
        message: `Trust passed but goal not met (${goalGates.metCount}/${goalGates.totalCount} criteria)`,
        suggestions: [
          `Attempt ${attempts.current + 1}/${attempts.max}: Try a different approach`,
          ...failedCriteria,
        ],
        isTerminal: false,
      };

    case "BLOCKED":
      // Goal is fundamentally blocked (impossible with current data/methods)
      return {
        decision: "BLOCKED",
        reason: "TRUST_PASS_GOAL_BLOCKED",
        message: "Goal cannot be achieved with current approach",
        blockers: goalGates.blockers || ["Goal gate returned BLOCKED status"],
        isTerminal: true,
      };

    default:
      // Unknown status - continue progressing
      return {
        decision: "CONTINUE",
        reason: "IN_PROGRESS",
        message: `Continuing research (cycle ${budgets.currentCycle}/${budgets.maxCycles})`,
        isTerminal: false,
      };
  }
}

/**
 * Get remaining budgets as a human-readable summary.
 *
 * @param budgets - Current budget state
 * @returns Summary string for display in continuation prompts
 *
 * @example
 * ```typescript
 * const summary = getBudgetSummary(budgets);
 * // "8/10 cycles, 45/60 min, 150/500 calls"
 * ```
 */
export function getBudgetSummary(budgets: BudgetState): string {
  const startTime = new Date(budgets.startedAt).getTime();
  const now = Date.now();
  const elapsedMinutes = Math.round((now - startTime) / 1000 / 60);

  return [
    `${budgets.currentCycle}/${budgets.maxCycles} cycles`,
    `${elapsedMinutes}/${budgets.maxTimeMinutes} min`,
    `${budgets.totalToolCalls}/${budgets.maxToolCalls} calls`,
  ].join(", ");
}

/**
 * Get the promise tag for a terminal decision.
 *
 * These tags are used by the Ralph-loop reinjection hook to detect
 * when the auto-loop should stop.
 *
 * @param decision - Terminal decision (COMPLETE or BLOCKED)
 * @param reason - Reason for the decision
 * @returns Promise tag string or null if not terminal
 *
 * @example
 * ```typescript
 * const tag = getPromiseTag("COMPLETE", "TRUST_AND_GOAL_PASS");
 * // "<promise>GYOSHU_AUTO_COMPLETE</promise>"
 *
 * const tag2 = getPromiseTag("BLOCKED", "CYCLES_EXHAUSTED");
 * // "<promise>GYOSHU_AUTO_BUDGET_EXHAUSTED</promise>"
 * ```
 */
export function getPromiseTag(
  decision: AutoDecision,
  reason: DecisionReason
): string | null {
  if (decision === "COMPLETE") {
    return "<promise>GYOSHU_AUTO_COMPLETE</promise>";
  }

  if (decision === "BUDGET_EXHAUSTED") {
    return "<promise>GYOSHU_AUTO_BUDGET_EXHAUSTED</promise>";
  }

  if (decision === "BLOCKED") {
    return "<promise>GYOSHU_AUTO_BLOCKED</promise>";
  }

  // Non-terminal decisions don't emit promise tags
  return null;
}

// =============================================================================
// TRUST AGGREGATION (Phase 4: Parallel Baksa Sharding)
// =============================================================================

/**
 * Verification status from a Baksa reviewer.
 */
export type VerificationStatus = "VERIFIED" | "PARTIAL" | "DOUBTFUL";

/**
 * Result of a single Baksa verification job.
 */
export interface VerificationResult {
  /** Unique job identifier */
  jobId: string;
  /** Path to the candidate being verified */
  candidatePath: string;
  /** Trust score assigned by this reviewer (0-100) */
  trustScore: number;
  /** Verification status */
  status: VerificationStatus;
  /** Number of findings that passed verification */
  findingsVerified: number;
  /** Number of findings that were rejected */
  findingsRejected: number;
}

/**
 * Consensus type for aggregated trust scores.
 * - unanimous: All reviewers agree (all VERIFIED or all not)
 * - majority: More than 50% agree
 * - split: 50% or less agree
 */
export type ConsensusType = "unanimous" | "majority" | "split";

/**
 * Result of aggregating trust scores from multiple reviewers.
 */
export interface AggregatedTrust {
  /** Aggregated trust score (conservative: minimum of all scores) */
  aggregatedScore: number;
  /** Whether the trust gate passes (score >= 80) */
  passed: boolean;
  /** Type of consensus among reviewers */
  consensus: ConsensusType;
}

/**
 * Aggregate trust scores from multiple verification results.
 * 
 * Uses conservative aggregation (minimum) to ensure safety:
 * - Per-claim trust = min(trustScoresFromReviewers)
 * - Stage trust = min(perClaimTrust) for critical claims
 * 
 * @param results - Array of verification results from Baksa reviewers
 * @returns Aggregated trust information
 * 
 * @example
 * ```typescript
 * const results = [
 *   { jobId: "j1", candidatePath: "/p1", trustScore: 90, status: "VERIFIED", findingsVerified: 3, findingsRejected: 0 },
 *   { jobId: "j2", candidatePath: "/p2", trustScore: 75, status: "PARTIAL", findingsVerified: 2, findingsRejected: 1 },
 * ];
 * const aggregated = aggregateTrustScores(results);
 * // aggregated.aggregatedScore === 75 (conservative: min)
 * // aggregated.passed === false (75 < 80)
 * // aggregated.consensus === "split" (not all VERIFIED)
 * ```
 */
export function aggregateTrustScores(results: VerificationResult[]): AggregatedTrust {
  if (results.length === 0) {
    return { aggregatedScore: 0, passed: false, consensus: "unanimous" };
  }

  if (results.length === 1) {
    const score = results[0].trustScore;
    return {
      aggregatedScore: score,
      passed: score >= TRUST_THRESHOLD,
      consensus: "unanimous",
    };
  }

  const minScore = Math.min(...results.map((r) => r.trustScore));
  const verifiedCount = results.filter((r) => r.status === "VERIFIED").length;
  const verifiedRatio = verifiedCount / results.length;

  let consensus: ConsensusType;
  if (verifiedRatio === 1 || verifiedRatio === 0) {
    consensus = "unanimous";
  } else if (verifiedRatio > 0.5) {
    consensus = "majority";
  } else {
    consensus = "split";
  }

  return {
    aggregatedScore: minScore,
    passed: minScore >= TRUST_THRESHOLD,
    consensus,
  };
}

// =============================================================================
// CANDIDATE SELECTION (Phase 4: Parallel Baksa Sharding)
// =============================================================================

/**
 * A candidate result from a parallel worker.
 */
export interface Candidate {
  /** Worker identifier that produced this candidate */
  workerId: string;
  /** Trust score for this candidate */
  trustScore: number;
  /** Progress toward goal (0.0 - 1.0) */
  goalProgress: number;
  /** Primary metric value (e.g., accuracy, F1 score) */
  primaryMetric: number;
  /** Path to the candidate's staging directory */
  candidatePath: string;
}

/**
 * Result of selecting the best candidate.
 */
export interface SelectionResult {
  /** The selected candidate, or null if none met the threshold */
  selected: Candidate | null;
  /** Reason for the selection (or rejection) */
  reason: string;
}

/**
 * Select the best candidate from parallel worker results.
 * 
 * Selection criteria (in priority order):
 * 1. trustScore >= 80 (required)
 * 2. Highest goalProgress (primary)
 * 3. Best primaryMetric (tiebreaker)
 * 
 * @param candidates - Array of candidates to choose from
 * @returns Selection result with chosen candidate or null
 * 
 * @example
 * ```typescript
 * const candidates = [
 *   { workerId: "w1", trustScore: 85, goalProgress: 0.8, primaryMetric: 0.9, candidatePath: "/p1" },
 *   { workerId: "w2", trustScore: 90, goalProgress: 0.9, primaryMetric: 0.85, candidatePath: "/p2" },
 * ];
 * const result = selectBestCandidate(candidates);
 * // result.selected === candidates[1] (higher goal progress)
 * // result.reason === "Selected w2: highest goal progress (0.9)"
 * ```
 */
export function selectBestCandidate(candidates: Candidate[]): SelectionResult {
  const qualifiedCandidates = candidates.filter(
    (c) => c.trustScore >= TRUST_THRESHOLD
  );

  if (qualifiedCandidates.length === 0) {
    if (candidates.length === 0) {
      return { selected: null, reason: "No candidates provided" };
    }
    const bestAttempt = candidates.reduce((best, c) =>
      c.trustScore > best.trustScore ? c : best
    );
    return {
      selected: null,
      reason: `All candidates rejected: highest trust score was ${bestAttempt.trustScore} (threshold: ${TRUST_THRESHOLD})`,
    };
  }

  if (qualifiedCandidates.length === 1) {
    const selected = qualifiedCandidates[0];
    return {
      selected,
      reason: `Selected ${selected.workerId}: only candidate meeting trust threshold`,
    };
  }

  const sorted = [...qualifiedCandidates].sort((a, b) => {
    if (a.goalProgress !== b.goalProgress) {
      return b.goalProgress - a.goalProgress;
    }
    return b.primaryMetric - a.primaryMetric;
  });

  const selected = sorted[0];
  
  let reason: string;
  if (sorted.length > 1 && selected.goalProgress > sorted[1].goalProgress) {
    reason = `Selected ${selected.workerId}: highest goal progress (${selected.goalProgress})`;
  } else if (sorted.length > 1 && selected.goalProgress === sorted[1].goalProgress) {
    reason = `Selected ${selected.workerId}: best primary metric (${selected.primaryMetric}) as tiebreaker`;
  } else {
    reason = `Selected ${selected.workerId}: trust ${selected.trustScore}, goal ${selected.goalProgress}, metric ${selected.primaryMetric}`;
  }

  return { selected, reason };
}
