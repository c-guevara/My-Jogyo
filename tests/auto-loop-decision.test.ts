/**
 * Auto-Loop Decision Engine Tests
 *
 * Tests the decision matrix for `/gyoshu-auto` continuation logic.
 * Verifies the Two-Gate decision system:
 * - Trust Gate: quality score >= 80
 * - Goal Gate: acceptance criteria met
 *
 * Decision Matrix:
 * | Trust Gate | Goal Gate | Decision |
 * |------------|-----------|----------|
 * | PASS (>=80)| MET       | COMPLETE |
 * | PASS (>=80)| NOT_MET   | PIVOT    |
 * | PASS (>=80)| BLOCKED   | BLOCKED  |
 * | FAIL (<80) | ANY       | REWORK   |
 * | ANY        | ANY       | CONTINUE | (when not claiming completion)
 *
 * @module auto-loop-decision.test
 */

import { describe, test, expect } from "bun:test";
import {
  decideNextAction,
  detectStagnation,
  updateStagnationState,
  createInitialStagnationState,
  checkBudgetExhaustion,
  TRUST_THRESHOLD,
  type DecisionParams,
  type BudgetState,
  type StagnationState,
} from "../src/lib/auto-decision";
import {
  hasPromiseTag,
  extractPromiseTags,
} from "../src/lib/auto-loop-state";
import type { QualityGateResult } from "../src/lib/quality-gates";
import type { GoalGateResult } from "../src/lib/goal-gates";

// =============================================================================
// TEST HELPERS
// =============================================================================

function mockQualityGates(
  overrides: Partial<QualityGateResult> = {}
): QualityGateResult {
  return {
    passed: true,
    score: 100,
    violations: [],
    findingsValidation: {
      total: 0,
      verified: 0,
      unverified: 0,
    },
    mlValidation: {
      hasBaseline: false,
      hasCV: false,
      hasInterpretation: false,
    },
    ...overrides,
  };
}

function mockGoalGates(
  overrides: Partial<GoalGateResult> = {}
): GoalGateResult {
  return {
    passed: true,
    overallStatus: "MET",
    criteriaResults: [],
    metCount: 0,
    totalCount: 0,
    ...overrides,
  };
}

function mockBudgets(overrides: Partial<BudgetState> = {}): BudgetState {
  return {
    maxCycles: 25,
    currentCycle: 1,
    maxToolCalls: 100,
    totalToolCalls: 5,
    maxTimeMinutes: 30,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function mockDecisionParams(
  overrides: Partial<DecisionParams> = {}
): DecisionParams {
  return {
    trustScore: 85,
    qualityGates: mockQualityGates(),
    goalGates: mockGoalGates(),
    attempts: { current: 1, max: 3 },
    reworkRounds: { current: 0, max: 3 },
    budgets: mockBudgets(),
    ...overrides,
  };
}

// =============================================================================
// DECISION ENGINE TESTS
// =============================================================================

describe("Auto-Decision Engine", () => {
  describe("decideNextAction", () => {
    describe("COMPLETE decisions", () => {
      test("returns COMPLETE when trust >= 80 and goals met", () => {
        const params = mockDecisionParams({
          trustScore: 85,
          qualityGates: mockQualityGates({ passed: true, score: 100 }),
          goalGates: mockGoalGates({ passed: true, overallStatus: "MET" }),
        });

        const result = decideNextAction(params);

        expect(result.decision).toBe("COMPLETE");
        expect(result.isTerminal).toBe(true);
      });

      test("returns COMPLETE at trust threshold boundary (exactly 80)", () => {
        const params = mockDecisionParams({
          trustScore: 80,
          qualityGates: mockQualityGates({ passed: true }),
          goalGates: mockGoalGates({ passed: true, overallStatus: "MET" }),
        });

        const result = decideNextAction(params);

        expect(result.decision).toBe("COMPLETE");
      });

      test("returns COMPLETE with high trust and all gates passed", () => {
        const params = mockDecisionParams({
          trustScore: 95,
          qualityGates: mockQualityGates({ passed: true, score: 100 }),
          goalGates: mockGoalGates({
            passed: true,
            overallStatus: "MET",
            metCount: 3,
            totalCount: 3,
          }),
        });

        const result = decideNextAction(params);

        expect(result.decision).toBe("COMPLETE");
        expect(result.reason).toBe("TRUST_AND_GOAL_PASS");
      });

      test("returns COMPLETE when goal has NO_CONTRACT status", () => {
        const params = mockDecisionParams({
          trustScore: 85,
          qualityGates: mockQualityGates({ passed: true }),
          goalGates: mockGoalGates({
            passed: true,
            overallStatus: "NO_CONTRACT" as "MET",
          }),
        });

        const result = decideNextAction(params);

        expect(result.decision).toBe("COMPLETE");
      });
    });

    describe("REWORK decisions", () => {
      test("returns REWORK when trust < 80", () => {
        const params = mockDecisionParams({
          trustScore: 75,
          qualityGates: mockQualityGates({ passed: true }),
          goalGates: mockGoalGates({ passed: true, overallStatus: "MET" }),
          reworkRounds: { current: 0, max: 3 },
        });

        const result = decideNextAction(params);

        expect(result.decision).toBe("REWORK");
        expect(result.reason).toBe("TRUST_FAIL");
        expect(result.isTerminal).toBe(false);
      });

      test("returns REWORK when trust at 79 (just below threshold)", () => {
        const params = mockDecisionParams({
          trustScore: 79,
          reworkRounds: { current: 0, max: 3 },
        });

        const result = decideNextAction(params);

        expect(result.decision).toBe("REWORK");
      });

      test("returns REWORK when quality gates failed", () => {
        const params = mockDecisionParams({
          trustScore: 85,
          qualityGates: mockQualityGates({
            passed: false,
            score: 60,
            violations: [
              { type: "FINDING_NO_CI", penalty: 30, lineNumber: 5, content: "test", message: "Missing CI" },
            ],
          }),
          goalGates: mockGoalGates({ passed: true, overallStatus: "MET" }),
          reworkRounds: { current: 0, max: 3 },
        });

        const result = decideNextAction(params);

        expect(result.decision).toBe("REWORK");
        expect(result.reason).toBe("QUALITY_FAIL");
      });

      test("returns REWORK on second round if trust still low", () => {
        const params = mockDecisionParams({
          trustScore: 70,
          reworkRounds: { current: 1, max: 3 },
        });

        const result = decideNextAction(params);

        expect(result.decision).toBe("REWORK");
      });

      test("returns REWORK when trust very low but rounds remaining", () => {
        const params = mockDecisionParams({
          trustScore: 45,
          reworkRounds: { current: 2, max: 3 },
        });

        const result = decideNextAction(params);

        expect(result.decision).toBe("REWORK");
      });
    });

    describe("PIVOT decisions", () => {
      test("returns PIVOT when trust OK but goal NOT_MET", () => {
        const params = mockDecisionParams({
          trustScore: 85,
          qualityGates: mockQualityGates({ passed: true }),
          goalGates: mockGoalGates({ passed: false, overallStatus: "NOT_MET" }),
          attempts: { current: 1, max: 3 },
        });

        const result = decideNextAction(params);

        expect(result.decision).toBe("PIVOT");
        expect(result.reason).toBe("TRUST_PASS_GOAL_NOT_MET");
        expect(result.isTerminal).toBe(false);
      });

      test("returns PIVOT on second attempt when goal still not met", () => {
        const params = mockDecisionParams({
          trustScore: 90,
          qualityGates: mockQualityGates({ passed: true }),
          goalGates: mockGoalGates({
            passed: false,
            overallStatus: "NOT_MET",
            metCount: 2,
            totalCount: 4,
          }),
          attempts: { current: 2, max: 3 },
        });

        const result = decideNextAction(params);

        expect(result.decision).toBe("PIVOT");
        expect(result.suggestions).toBeDefined();
      });

      test("returns PIVOT with suggestions for failed criteria", () => {
        const params = mockDecisionParams({
          trustScore: 82,
          qualityGates: mockQualityGates({ passed: true, score: 85 }),
          goalGates: mockGoalGates({
            passed: false,
            overallStatus: "NOT_MET",
            criteriaResults: [
              {
                criterion: {
                  id: "AC1",
                  kind: "metric_threshold",
                  metric: "accuracy",
                  op: ">=",
                  target: 0.9,
                },
                status: "NOT_MET",
                actualValue: 0.85,
                message: "accuracy (0.85) < target (0.90)",
              },
            ],
            metCount: 0,
            totalCount: 1,
          }),
          attempts: { current: 1, max: 3 },
        });

        const result = decideNextAction(params);

        expect(result.decision).toBe("PIVOT");
        expect(result.suggestions).toContain("accuracy (0.85) < target (0.90)");
      });
    });

    describe("BLOCKED decisions", () => {
      test("returns BLOCKED when goal BLOCKED", () => {
        const params = mockDecisionParams({
          trustScore: 85,
          qualityGates: mockQualityGates({ passed: true }),
          goalGates: mockGoalGates({
            passed: false,
            overallStatus: "BLOCKED",
            blockers: ["Data does not support hypothesis"],
          }),
        });

        const result = decideNextAction(params);

        expect(result.decision).toBe("BLOCKED");
        expect(result.reason).toBe("TRUST_PASS_GOAL_BLOCKED");
        expect(result.isTerminal).toBe(true);
      });

      test("returns BLOCKED when rework rounds exhausted", () => {
        const params = mockDecisionParams({
          trustScore: 70,
          reworkRounds: { current: 3, max: 3 },
        });

        const result = decideNextAction(params);

        expect(result.decision).toBe("BLOCKED");
        expect(result.reason).toBe("REWORK_EXHAUSTED");
      });

      test("returns BLOCKED when pivot attempts exhausted", () => {
        const params = mockDecisionParams({
          trustScore: 85,
          qualityGates: mockQualityGates({ passed: true }),
          goalGates: mockGoalGates({ passed: false, overallStatus: "NOT_MET" }),
          attempts: { current: 3, max: 3 },
        });

        const result = decideNextAction(params);

        expect(result.decision).toBe("BLOCKED");
        expect(result.reason).toBe("ATTEMPTS_EXHAUSTED");
      });

      test("returns BUDGET_EXHAUSTED when cycle budget exhausted", () => {
        const params = mockDecisionParams({
          trustScore: 85,
          qualityGates: mockQualityGates({ passed: true }),
          goalGates: mockGoalGates({ passed: false, overallStatus: "NOT_MET" }),
          budgets: mockBudgets({
            maxCycles: 25,
            currentCycle: 25,
          }),
        });

        const result = decideNextAction(params);

        expect(result.decision).toBe("BUDGET_EXHAUSTED");
        expect(result.reason).toBe("CYCLES_EXHAUSTED");
      });

      test("returns BUDGET_EXHAUSTED when tool call budget exhausted", () => {
        const params = mockDecisionParams({
          trustScore: 85,
          qualityGates: mockQualityGates({ passed: true }),
          goalGates: mockGoalGates({ passed: false, overallStatus: "NOT_MET" }),
          budgets: mockBudgets({
            maxToolCalls: 100,
            totalToolCalls: 100,
          }),
        });

        const result = decideNextAction(params);

        expect(result.decision).toBe("BUDGET_EXHAUSTED");
        expect(result.reason).toBe("TOOL_CALLS_EXHAUSTED");
      });

      test("returns BUDGET_EXHAUSTED when time budget exhausted", () => {
        const pastStart = new Date(Date.now() - 35 * 60 * 1000).toISOString();
        const params = mockDecisionParams({
          trustScore: 85,
          qualityGates: mockQualityGates({ passed: true }),
          goalGates: mockGoalGates({ passed: false, overallStatus: "NOT_MET" }),
          budgets: mockBudgets({
            maxTimeMinutes: 30,
            startedAt: pastStart,
          }),
        });

        const result = decideNextAction(params);

        expect(result.decision).toBe("BUDGET_EXHAUSTED");
        expect(result.reason).toBe("TIME_EXHAUSTED");
      });
    });

    describe("stagnation detection", () => {
      test("returns BLOCKED when stagnation detected", () => {
        const stagnation: StagnationState = {
          cyclesWithoutNewCells: 5,
          cyclesWithoutNewArtifacts: 5,
          cyclesWithoutNewMarkers: 5,
          lastCellCount: 10,
          lastArtifactCount: 3,
          lastMarkerCount: 15,
        };

        const params = mockDecisionParams({
          trustScore: 85,
          qualityGates: mockQualityGates({ passed: true }),
          goalGates: mockGoalGates({ passed: false, overallStatus: "NOT_MET" }),
          stagnation,
          stagnationThreshold: 3,
        });

        const result = decideNextAction(params);

        expect(result.decision).toBe("BLOCKED");
        expect(result.reason).toBe("STAGNATION_DETECTED");
      });

      test("does not return BLOCKED when stagnation threshold not reached", () => {
        const stagnation: StagnationState = {
          cyclesWithoutNewCells: 2,
          cyclesWithoutNewArtifacts: 2,
          cyclesWithoutNewMarkers: 2,
          lastCellCount: 10,
          lastArtifactCount: 3,
          lastMarkerCount: 15,
        };

        const params = mockDecisionParams({
          trustScore: 85,
          qualityGates: mockQualityGates({ passed: true }),
          goalGates: mockGoalGates({ passed: false, overallStatus: "NOT_MET" }),
          stagnation,
          stagnationThreshold: 3,
          attempts: { current: 1, max: 3 },
        });

        const result = decideNextAction(params);

        expect(result.decision).toBe("PIVOT");
      });
    });

    describe("edge cases", () => {
      test("handles zero budgets gracefully", () => {
        const params = mockDecisionParams({
          budgets: mockBudgets({
            maxCycles: 0,
            currentCycle: 0,
          }),
        });

        const result = decideNextAction(params);

        expect(result.decision).toBe("BUDGET_EXHAUSTED");
      });

      test("returns BLOCKED when trust low AND goal BLOCKED (per spec: escalate to user)", () => {
        // Per spec: FAIL (<80) + BLOCKED => BLOCKED (Fundamental issue, escalate to user)
        const params = mockDecisionParams({
          trustScore: 70,
          goalGates: mockGoalGates({
            passed: false,
            overallStatus: "BLOCKED",
          }),
          reworkRounds: { current: 0, max: 3 },
        });

        const result = decideNextAction(params);

        expect(result.decision).toBe("BLOCKED");
      });

      test("returns BLOCKED when goal BLOCKED and trust passes", () => {
        const params = mockDecisionParams({
          trustScore: 85,
          qualityGates: mockQualityGates({ passed: true }),
          goalGates: mockGoalGates({
            passed: false,
            overallStatus: "BLOCKED",
          }),
        });

        const result = decideNextAction(params);

        expect(result.decision).toBe("BLOCKED");
      });

      test("prioritizes BLOCKED over PIVOT when attempts exhausted", () => {
        const params = mockDecisionParams({
          trustScore: 85,
          qualityGates: mockQualityGates({ passed: true }),
          goalGates: mockGoalGates({ passed: false, overallStatus: "NOT_MET" }),
          attempts: { current: 5, max: 3 },
        });

        const result = decideNextAction(params);

        expect(result.decision).toBe("BLOCKED");
      });

      test("handles negative trust score as failing", () => {
        const params = mockDecisionParams({
          trustScore: -10,
          reworkRounds: { current: 0, max: 3 },
        });

        const result = decideNextAction(params);

        expect(result.decision).toBe("REWORK");
      });

      test("handles trust score over 100 as passing", () => {
        const params = mockDecisionParams({
          trustScore: 105,
          qualityGates: mockQualityGates({ passed: true }),
          goalGates: mockGoalGates({ passed: true, overallStatus: "MET" }),
        });

        const result = decideNextAction(params);

        expect(result.decision).toBe("COMPLETE");
      });
    });
  });

  describe("detectStagnation", () => {
    test("detects stagnation when all metrics exceed threshold", () => {
      const stagnation: StagnationState = {
        cyclesWithoutNewCells: 4,
        cyclesWithoutNewArtifacts: 4,
        cyclesWithoutNewMarkers: 4,
        lastCellCount: 10,
        lastArtifactCount: 3,
        lastMarkerCount: 15,
      };

      const result = detectStagnation(stagnation, 3);

      expect(result).toBe(true);
    });

    test("does not detect stagnation when cells are progressing", () => {
      const stagnation: StagnationState = {
        cyclesWithoutNewCells: 1,
        cyclesWithoutNewArtifacts: 5,
        cyclesWithoutNewMarkers: 5,
        lastCellCount: 10,
        lastArtifactCount: 3,
        lastMarkerCount: 15,
      };

      const result = detectStagnation(stagnation, 3);

      expect(result).toBe(false);
    });

    test("does not detect stagnation when artifacts are progressing", () => {
      const stagnation: StagnationState = {
        cyclesWithoutNewCells: 5,
        cyclesWithoutNewArtifacts: 1,
        cyclesWithoutNewMarkers: 5,
        lastCellCount: 10,
        lastArtifactCount: 3,
        lastMarkerCount: 15,
      };

      const result = detectStagnation(stagnation, 3);

      expect(result).toBe(false);
    });

    test("does not detect stagnation when markers are progressing", () => {
      const stagnation: StagnationState = {
        cyclesWithoutNewCells: 5,
        cyclesWithoutNewArtifacts: 5,
        cyclesWithoutNewMarkers: 1,
        lastCellCount: 10,
        lastArtifactCount: 3,
        lastMarkerCount: 15,
      };

      const result = detectStagnation(stagnation, 3);

      expect(result).toBe(false);
    });

    test("uses default threshold of 3", () => {
      const stagnation: StagnationState = {
        cyclesWithoutNewCells: 3,
        cyclesWithoutNewArtifacts: 3,
        cyclesWithoutNewMarkers: 3,
        lastCellCount: 10,
        lastArtifactCount: 3,
        lastMarkerCount: 15,
      };

      const result = detectStagnation(stagnation);

      expect(result).toBe(true);
    });
  });

  describe("updateStagnationState", () => {
    test("resets counter when cells increase", () => {
      const current: StagnationState = {
        cyclesWithoutNewCells: 5,
        cyclesWithoutNewArtifacts: 5,
        cyclesWithoutNewMarkers: 5,
        lastCellCount: 10,
        lastArtifactCount: 3,
        lastMarkerCount: 15,
      };

      const updated = updateStagnationState(current, 12, 3, 15);

      expect(updated.cyclesWithoutNewCells).toBe(0);
      expect(updated.cyclesWithoutNewArtifacts).toBe(6);
      expect(updated.cyclesWithoutNewMarkers).toBe(6);
    });

    test("increments counters when no progress", () => {
      const current: StagnationState = {
        cyclesWithoutNewCells: 2,
        cyclesWithoutNewArtifacts: 2,
        cyclesWithoutNewMarkers: 2,
        lastCellCount: 10,
        lastArtifactCount: 3,
        lastMarkerCount: 15,
      };

      const updated = updateStagnationState(current, 10, 3, 15);

      expect(updated.cyclesWithoutNewCells).toBe(3);
      expect(updated.cyclesWithoutNewArtifacts).toBe(3);
      expect(updated.cyclesWithoutNewMarkers).toBe(3);
    });
  });

  describe("createInitialStagnationState", () => {
    test("creates state with zero counters", () => {
      const state = createInitialStagnationState(10, 3, 5);

      expect(state.cyclesWithoutNewCells).toBe(0);
      expect(state.cyclesWithoutNewArtifacts).toBe(0);
      expect(state.cyclesWithoutNewMarkers).toBe(0);
      expect(state.lastCellCount).toBe(10);
      expect(state.lastArtifactCount).toBe(3);
      expect(state.lastMarkerCount).toBe(5);
    });
  });

  describe("checkBudgetExhaustion", () => {
    test("returns not exhausted for normal budgets", () => {
      const budgets = mockBudgets();
      const result = checkBudgetExhaustion(budgets);

      expect(result.exhausted).toBe(false);
    });

    test("detects cycle exhaustion", () => {
      const budgets = mockBudgets({ maxCycles: 10, currentCycle: 10 });
      const result = checkBudgetExhaustion(budgets);

      expect(result.exhausted).toBe(true);
      expect(result.reason).toBe("CYCLES_EXHAUSTED");
    });

    test("detects tool call exhaustion", () => {
      const budgets = mockBudgets({ maxToolCalls: 50, totalToolCalls: 50 });
      const result = checkBudgetExhaustion(budgets);

      expect(result.exhausted).toBe(true);
      expect(result.reason).toBe("TOOL_CALLS_EXHAUSTED");
    });
  });
});

// =============================================================================
// PROMISE TAG PARSING TESTS
// =============================================================================

describe("Promise Tag Parsing", () => {
  describe("hasPromiseTag", () => {
    test("detects promise tag in output", () => {
      const output = "Research complete\n<promise>GYOSHU_AUTO_COMPLETE</promise>";
      const result = hasPromiseTag(output, "GYOSHU_AUTO_COMPLETE");
      expect(result).toBe(true);
    });

    test("detects BLOCKED promise tag", () => {
      const output = "Cannot proceed\n<promise>GYOSHU_AUTO_BLOCKED</promise>";
      const result = hasPromiseTag(output, "GYOSHU_AUTO_BLOCKED");
      expect(result).toBe(true);
    });

    test("detects BUDGET_EXHAUSTED promise tag", () => {
      const output = "<promise>GYOSHU_AUTO_BUDGET_EXHAUSTED</promise>\nBudget limit reached";
      const result = hasPromiseTag(output, "GYOSHU_AUTO_BUDGET_EXHAUSTED");
      expect(result).toBe(true);
    });

    test("returns false for missing tag", () => {
      const output = "Just regular output without any promise tag";
      const result = hasPromiseTag(output, "GYOSHU_AUTO_COMPLETE");
      expect(result).toBe(false);
    });

    test("returns false for wrong tag type", () => {
      const output = "<promise>GYOSHU_AUTO_BLOCKED</promise>";
      const result = hasPromiseTag(output, "GYOSHU_AUTO_COMPLETE");
      expect(result).toBe(false);
    });

    test("handles case insensitivity for tag name", () => {
      const output = "<promise>gyoshu_auto_complete</promise>";
      const result = hasPromiseTag(output, "GYOSHU_AUTO_COMPLETE");
      expect(result).toBe(true);
    });

    test("handles case insensitivity for promise wrapper", () => {
      const output = "<PROMISE>GYOSHU_AUTO_COMPLETE</PROMISE>";
      const result = hasPromiseTag(output, "GYOSHU_AUTO_COMPLETE");
      expect(result).toBe(true);
    });

    test("handles whitespace inside tag", () => {
      const output = "<promise> GYOSHU_AUTO_COMPLETE </promise>";
      const result = hasPromiseTag(output, "GYOSHU_AUTO_COMPLETE");
      expect(result).toBe(true);
    });

    test("handles multiple promise tags in output", () => {
      const output = `First attempt: <promise>GYOSHU_AUTO_BLOCKED</promise>
After fix: <promise>GYOSHU_AUTO_COMPLETE</promise>`;

      expect(hasPromiseTag(output, "GYOSHU_AUTO_COMPLETE")).toBe(true);
      expect(hasPromiseTag(output, "GYOSHU_AUTO_BLOCKED")).toBe(true);
    });

    test("handles empty output", () => {
      const result = hasPromiseTag("", "GYOSHU_AUTO_COMPLETE");
      expect(result).toBe(false);
    });

    test("handles tag with no content", () => {
      const output = "<promise></promise>";
      const result = hasPromiseTag(output, "GYOSHU_AUTO_COMPLETE");
      expect(result).toBe(false);
    });

    test("does not match partial tag names", () => {
      const output = "<promise>GYOSHU_AUTO</promise>";
      const result = hasPromiseTag(output, "GYOSHU_AUTO_COMPLETE");
      expect(result).toBe(false);
    });

    test("does not match tag outside of promise wrapper", () => {
      const output = "GYOSHU_AUTO_COMPLETE is the status";
      const result = hasPromiseTag(output, "GYOSHU_AUTO_COMPLETE");
      expect(result).toBe(false);
    });

    test("handles malformed promise tags gracefully", () => {
      const outputs = [
        "<promise>GYOSHU_AUTO_COMPLETE",
        "GYOSHU_AUTO_COMPLETE</promise>",
        "<promise GYOSHU_AUTO_COMPLETE>",
        "<promise>GYOSHU_AUTO_COMPLETE</promise",
      ];

      for (const output of outputs) {
        expect(() => hasPromiseTag(output, "GYOSHU_AUTO_COMPLETE")).not.toThrow();
      }
    });
  });

  describe("extractPromiseTags", () => {
    test("extracts single tag", () => {
      const output = "<promise>GYOSHU_AUTO_COMPLETE</promise>";
      const tags = extractPromiseTags(output);
      expect(tags).toEqual(["GYOSHU_AUTO_COMPLETE"]);
    });

    test("extracts multiple tags", () => {
      const output = "<promise>TAG1</promise> text <promise>TAG2</promise>";
      const tags = extractPromiseTags(output);
      expect(tags).toEqual(["TAG1", "TAG2"]);
    });

    test("handles empty output", () => {
      const tags = extractPromiseTags("");
      expect(tags).toEqual([]);
    });

    test("handles output with no tags", () => {
      const tags = extractPromiseTags("no tags here");
      expect(tags).toEqual([]);
    });

    test("trims whitespace from tag content", () => {
      const output = "<promise> TAG_WITH_SPACES </promise>";
      const tags = extractPromiseTags(output);
      expect(tags).toEqual(["TAG_WITH_SPACES"]);
    });
  });
});

// =============================================================================
// TRUST AGGREGATION TESTS (Phase 4)
// =============================================================================

import {
  aggregateTrustScores,
  selectBestCandidate,
  type VerificationResult,
  type Candidate,
} from "../src/lib/auto-decision";

describe("aggregateTrustScores", () => {
  describe("empty input", () => {
    test("returns score 0 for empty array", () => {
      const result = aggregateTrustScores([]);
      expect(result.aggregatedScore).toBe(0);
    });

    test("returns passed false for empty array", () => {
      const result = aggregateTrustScores([]);
      expect(result.passed).toBe(false);
    });

    test("returns unanimous consensus for empty array", () => {
      const result = aggregateTrustScores([]);
      expect(result.consensus).toBe("unanimous");
    });
  });

  describe("single verification", () => {
    test("returns exact score from single verification", () => {
      const results: VerificationResult[] = [
        {
          jobId: "j1",
          candidatePath: "/p1",
          trustScore: 85,
          status: "VERIFIED",
          findingsVerified: 3,
          findingsRejected: 0,
        },
      ];
      const result = aggregateTrustScores(results);
      expect(result.aggregatedScore).toBe(85);
    });

    test("returns passed true when single score >= 80", () => {
      const results: VerificationResult[] = [
        {
          jobId: "j1",
          candidatePath: "/p1",
          trustScore: 80,
          status: "VERIFIED",
          findingsVerified: 2,
          findingsRejected: 0,
        },
      ];
      const result = aggregateTrustScores(results);
      expect(result.passed).toBe(true);
    });

    test("returns passed false when single score < 80", () => {
      const results: VerificationResult[] = [
        {
          jobId: "j1",
          candidatePath: "/p1",
          trustScore: 79,
          status: "PARTIAL",
          findingsVerified: 1,
          findingsRejected: 1,
        },
      ];
      const result = aggregateTrustScores(results);
      expect(result.passed).toBe(false);
    });

    test("returns unanimous consensus for single verification", () => {
      const results: VerificationResult[] = [
        {
          jobId: "j1",
          candidatePath: "/p1",
          trustScore: 90,
          status: "VERIFIED",
          findingsVerified: 5,
          findingsRejected: 0,
        },
      ];
      const result = aggregateTrustScores(results);
      expect(result.consensus).toBe("unanimous");
    });
  });

  describe("conservative aggregation (minimum)", () => {
    test("uses minimum score when multiple verifications provided", () => {
      const results: VerificationResult[] = [
        { jobId: "j1", candidatePath: "/p1", trustScore: 90, status: "VERIFIED", findingsVerified: 3, findingsRejected: 0 },
        { jobId: "j2", candidatePath: "/p2", trustScore: 70, status: "PARTIAL", findingsVerified: 2, findingsRejected: 1 },
      ];
      const result = aggregateTrustScores(results);
      expect(result.aggregatedScore).toBe(70);
    });

    test("returns passed false when minimum < 80", () => {
      const results: VerificationResult[] = [
        { jobId: "j1", candidatePath: "/p1", trustScore: 95, status: "VERIFIED", findingsVerified: 5, findingsRejected: 0 },
        { jobId: "j2", candidatePath: "/p2", trustScore: 75, status: "PARTIAL", findingsVerified: 3, findingsRejected: 2 },
        { jobId: "j3", candidatePath: "/p3", trustScore: 88, status: "VERIFIED", findingsVerified: 4, findingsRejected: 0 },
      ];
      const result = aggregateTrustScores(results);
      expect(result.passed).toBe(false);
    });

    test("returns passed true when all scores >= 80", () => {
      const results: VerificationResult[] = [
        { jobId: "j1", candidatePath: "/p1", trustScore: 95, status: "VERIFIED", findingsVerified: 5, findingsRejected: 0 },
        { jobId: "j2", candidatePath: "/p2", trustScore: 80, status: "VERIFIED", findingsVerified: 3, findingsRejected: 0 },
        { jobId: "j3", candidatePath: "/p3", trustScore: 88, status: "VERIFIED", findingsVerified: 4, findingsRejected: 0 },
      ];
      const result = aggregateTrustScores(results);
      expect(result.passed).toBe(true);
      expect(result.aggregatedScore).toBe(80);
    });
  });

  describe("consensus calculation", () => {
    test("returns unanimous when all VERIFIED", () => {
      const results: VerificationResult[] = [
        { jobId: "j1", candidatePath: "/p1", trustScore: 90, status: "VERIFIED", findingsVerified: 3, findingsRejected: 0 },
        { jobId: "j2", candidatePath: "/p2", trustScore: 85, status: "VERIFIED", findingsVerified: 3, findingsRejected: 0 },
        { jobId: "j3", candidatePath: "/p3", trustScore: 88, status: "VERIFIED", findingsVerified: 4, findingsRejected: 0 },
      ];
      const result = aggregateTrustScores(results);
      expect(result.consensus).toBe("unanimous");
    });

    test("returns unanimous when all not VERIFIED", () => {
      const results: VerificationResult[] = [
        { jobId: "j1", candidatePath: "/p1", trustScore: 60, status: "PARTIAL", findingsVerified: 1, findingsRejected: 2 },
        { jobId: "j2", candidatePath: "/p2", trustScore: 55, status: "DOUBTFUL", findingsVerified: 0, findingsRejected: 3 },
      ];
      const result = aggregateTrustScores(results);
      expect(result.consensus).toBe("unanimous");
    });

    test("returns majority when > 50% VERIFIED", () => {
      const results: VerificationResult[] = [
        { jobId: "j1", candidatePath: "/p1", trustScore: 90, status: "VERIFIED", findingsVerified: 3, findingsRejected: 0 },
        { jobId: "j2", candidatePath: "/p2", trustScore: 85, status: "VERIFIED", findingsVerified: 2, findingsRejected: 0 },
        { jobId: "j3", candidatePath: "/p3", trustScore: 70, status: "PARTIAL", findingsVerified: 1, findingsRejected: 2 },
      ];
      const result = aggregateTrustScores(results);
      expect(result.consensus).toBe("majority");
    });

    test("returns split when exactly 50% VERIFIED", () => {
      const results: VerificationResult[] = [
        { jobId: "j1", candidatePath: "/p1", trustScore: 90, status: "VERIFIED", findingsVerified: 3, findingsRejected: 0 },
        { jobId: "j2", candidatePath: "/p2", trustScore: 70, status: "PARTIAL", findingsVerified: 1, findingsRejected: 2 },
      ];
      const result = aggregateTrustScores(results);
      expect(result.consensus).toBe("split");
    });

    test("returns split when < 50% VERIFIED", () => {
      const results: VerificationResult[] = [
        { jobId: "j1", candidatePath: "/p1", trustScore: 90, status: "VERIFIED", findingsVerified: 3, findingsRejected: 0 },
        { jobId: "j2", candidatePath: "/p2", trustScore: 70, status: "PARTIAL", findingsVerified: 1, findingsRejected: 2 },
        { jobId: "j3", candidatePath: "/p3", trustScore: 65, status: "DOUBTFUL", findingsVerified: 0, findingsRejected: 3 },
        { jobId: "j4", candidatePath: "/p4", trustScore: 60, status: "PARTIAL", findingsVerified: 1, findingsRejected: 2 },
      ];
      const result = aggregateTrustScores(results);
      expect(result.consensus).toBe("split");
    });
  });

  describe("edge cases", () => {
    test("handles trust score of exactly 80", () => {
      const results: VerificationResult[] = [
        { jobId: "j1", candidatePath: "/p1", trustScore: 80, status: "VERIFIED", findingsVerified: 2, findingsRejected: 0 },
      ];
      const result = aggregateTrustScores(results);
      expect(result.aggregatedScore).toBe(80);
      expect(result.passed).toBe(true);
    });

    test("handles trust score of 0", () => {
      const results: VerificationResult[] = [
        { jobId: "j1", candidatePath: "/p1", trustScore: 0, status: "DOUBTFUL", findingsVerified: 0, findingsRejected: 5 },
      ];
      const result = aggregateTrustScores(results);
      expect(result.aggregatedScore).toBe(0);
      expect(result.passed).toBe(false);
    });

    test("handles trust score of 100", () => {
      const results: VerificationResult[] = [
        { jobId: "j1", candidatePath: "/p1", trustScore: 100, status: "VERIFIED", findingsVerified: 10, findingsRejected: 0 },
      ];
      const result = aggregateTrustScores(results);
      expect(result.aggregatedScore).toBe(100);
      expect(result.passed).toBe(true);
    });
  });
});

// =============================================================================
// CANDIDATE SELECTION TESTS (Phase 4)
// =============================================================================

describe("selectBestCandidate", () => {
  describe("no candidates", () => {
    test("returns null when no candidates provided", () => {
      const result = selectBestCandidate([]);
      expect(result.selected).toBeNull();
    });

    test("returns descriptive reason for empty input", () => {
      const result = selectBestCandidate([]);
      expect(result.reason).toBe("No candidates provided");
    });
  });

  describe("rejection when none meet threshold", () => {
    test("returns null when all candidates below threshold", () => {
      const candidates: Candidate[] = [
        { workerId: "w1", trustScore: 65, goalProgress: 0.8, primaryMetric: 0.9, candidatePath: "/p1" },
        { workerId: "w2", trustScore: 75, goalProgress: 0.9, primaryMetric: 0.95, candidatePath: "/p2" },
      ];
      const result = selectBestCandidate(candidates);
      expect(result.selected).toBeNull();
    });

    test("includes highest rejected score in reason", () => {
      const candidates: Candidate[] = [
        { workerId: "w1", trustScore: 65, goalProgress: 0.8, primaryMetric: 0.9, candidatePath: "/p1" },
        { workerId: "w2", trustScore: 75, goalProgress: 0.9, primaryMetric: 0.95, candidatePath: "/p2" },
      ];
      const result = selectBestCandidate(candidates);
      expect(result.reason).toContain("75");
      expect(result.reason).toContain("80");
    });

    test("rejects candidate at exactly 79", () => {
      const candidates: Candidate[] = [
        { workerId: "w1", trustScore: 79, goalProgress: 0.95, primaryMetric: 0.99, candidatePath: "/p1" },
      ];
      const result = selectBestCandidate(candidates);
      expect(result.selected).toBeNull();
    });
  });

  describe("single qualified candidate", () => {
    test("selects only candidate meeting threshold", () => {
      const candidates: Candidate[] = [
        { workerId: "w1", trustScore: 70, goalProgress: 0.9, primaryMetric: 0.95, candidatePath: "/p1" },
        { workerId: "w2", trustScore: 85, goalProgress: 0.7, primaryMetric: 0.8, candidatePath: "/p2" },
      ];
      const result = selectBestCandidate(candidates);
      expect(result.selected?.workerId).toBe("w2");
    });

    test("includes reason for single qualified selection", () => {
      const candidates: Candidate[] = [
        { workerId: "w1", trustScore: 85, goalProgress: 0.8, primaryMetric: 0.9, candidatePath: "/p1" },
        { workerId: "w2", trustScore: 75, goalProgress: 0.9, primaryMetric: 0.95, candidatePath: "/p2" },
      ];
      const result = selectBestCandidate(candidates);
      expect(result.reason).toContain("only candidate");
    });

    test("accepts candidate at exactly 80", () => {
      const candidates: Candidate[] = [
        { workerId: "w1", trustScore: 80, goalProgress: 0.5, primaryMetric: 0.6, candidatePath: "/p1" },
      ];
      const result = selectBestCandidate(candidates);
      expect(result.selected?.workerId).toBe("w1");
    });
  });

  describe("goal progress preference", () => {
    test("prefers higher goal progress when trust equal", () => {
      const candidates: Candidate[] = [
        { workerId: "w1", trustScore: 85, goalProgress: 0.7, primaryMetric: 0.9, candidatePath: "/p1" },
        { workerId: "w2", trustScore: 85, goalProgress: 0.9, primaryMetric: 0.7, candidatePath: "/p2" },
      ];
      const result = selectBestCandidate(candidates);
      expect(result.selected?.workerId).toBe("w2");
    });

    test("prefers higher goal progress even with lower trust (above threshold)", () => {
      const candidates: Candidate[] = [
        { workerId: "w1", trustScore: 95, goalProgress: 0.6, primaryMetric: 0.9, candidatePath: "/p1" },
        { workerId: "w2", trustScore: 82, goalProgress: 0.9, primaryMetric: 0.7, candidatePath: "/p2" },
      ];
      const result = selectBestCandidate(candidates);
      expect(result.selected?.workerId).toBe("w2");
    });

    test("includes goal progress in reason", () => {
      const candidates: Candidate[] = [
        { workerId: "w1", trustScore: 85, goalProgress: 0.7, primaryMetric: 0.9, candidatePath: "/p1" },
        { workerId: "w2", trustScore: 85, goalProgress: 0.9, primaryMetric: 0.7, candidatePath: "/p2" },
      ];
      const result = selectBestCandidate(candidates);
      expect(result.reason).toContain("goal progress");
      expect(result.reason).toContain("0.9");
    });
  });

  describe("metric tiebreaker", () => {
    test("uses primaryMetric as tiebreaker when goal progress equal", () => {
      const candidates: Candidate[] = [
        { workerId: "w1", trustScore: 85, goalProgress: 0.8, primaryMetric: 0.85, candidatePath: "/p1" },
        { workerId: "w2", trustScore: 85, goalProgress: 0.8, primaryMetric: 0.95, candidatePath: "/p2" },
      ];
      const result = selectBestCandidate(candidates);
      expect(result.selected?.workerId).toBe("w2");
    });

    test("includes tiebreaker in reason when metrics differ", () => {
      const candidates: Candidate[] = [
        { workerId: "w1", trustScore: 85, goalProgress: 0.8, primaryMetric: 0.85, candidatePath: "/p1" },
        { workerId: "w2", trustScore: 85, goalProgress: 0.8, primaryMetric: 0.95, candidatePath: "/p2" },
      ];
      const result = selectBestCandidate(candidates);
      expect(result.reason).toContain("tiebreaker");
    });

    test("handles three-way tie with different metrics", () => {
      const candidates: Candidate[] = [
        { workerId: "w1", trustScore: 85, goalProgress: 0.8, primaryMetric: 0.80, candidatePath: "/p1" },
        { workerId: "w2", trustScore: 85, goalProgress: 0.8, primaryMetric: 0.95, candidatePath: "/p2" },
        { workerId: "w3", trustScore: 85, goalProgress: 0.8, primaryMetric: 0.90, candidatePath: "/p3" },
      ];
      const result = selectBestCandidate(candidates);
      expect(result.selected?.workerId).toBe("w2");
    });
  });

  describe("selection reason", () => {
    test("returns reason for selected candidate", () => {
      const candidates: Candidate[] = [
        { workerId: "w1", trustScore: 85, goalProgress: 0.9, primaryMetric: 0.9, candidatePath: "/p1" },
      ];
      const result = selectBestCandidate(candidates);
      expect(result.reason).toBeDefined();
      expect(result.reason.length).toBeGreaterThan(0);
    });

    test("reason includes worker ID", () => {
      const candidates: Candidate[] = [
        { workerId: "worker-123", trustScore: 85, goalProgress: 0.9, primaryMetric: 0.9, candidatePath: "/p1" },
      ];
      const result = selectBestCandidate(candidates);
      expect(result.reason).toContain("worker-123");
    });
  });

  describe("complex scenarios", () => {
    test("handles mixed qualified and unqualified candidates", () => {
      const candidates: Candidate[] = [
        { workerId: "w1", trustScore: 75, goalProgress: 0.95, primaryMetric: 0.99, candidatePath: "/p1" },
        { workerId: "w2", trustScore: 85, goalProgress: 0.7, primaryMetric: 0.8, candidatePath: "/p2" },
        { workerId: "w3", trustScore: 90, goalProgress: 0.8, primaryMetric: 0.85, candidatePath: "/p3" },
        { workerId: "w4", trustScore: 70, goalProgress: 0.9, primaryMetric: 0.9, candidatePath: "/p4" },
      ];
      const result = selectBestCandidate(candidates);
      expect(result.selected?.workerId).toBe("w3");
    });

    test("preserves candidate data in selection result", () => {
      const candidates: Candidate[] = [
        { workerId: "w1", trustScore: 90, goalProgress: 0.85, primaryMetric: 0.92, candidatePath: "/staging/w1" },
      ];
      const result = selectBestCandidate(candidates);
      expect(result.selected).toEqual(candidates[0]);
    });

    test("does not modify original candidates array", () => {
      const candidates: Candidate[] = [
        { workerId: "w1", trustScore: 85, goalProgress: 0.7, primaryMetric: 0.9, candidatePath: "/p1" },
        { workerId: "w2", trustScore: 85, goalProgress: 0.9, primaryMetric: 0.7, candidatePath: "/p2" },
      ];
      const originalFirst = candidates[0];
      selectBestCandidate(candidates);
      expect(candidates[0]).toBe(originalFirst);
    });
  });
});
