/**
 * Quality Gate Integration Tests
 *
 * These tests verify the end-to-end quality gate system that enforces
 * senior data scientist standards on research outputs.
 *
 * Test Scenarios:
 * 1. Good research with proper statistical evidence -> SUCCESS (score 100)
 * 2. Shallow research missing evidence -> PARTIAL (downgraded)
 * 3. Finding categorization in reports (verified/partial/exploratory)
 * 4. IMRAD section validation
 */

import { describe, test, expect } from "bun:test";
import {
  runQualityGates,
  validateFindings,
  validateMLPipeline,
} from "../src/lib/quality-gates";
import {
  separateFindings,
  validateIMRADSections,
  buildReportModel,
  renderReportMarkdown,
} from "../src/lib/report-markdown";
import { parseMarkers, getMarkersByType } from "../src/lib/marker-parser";

// =============================================================================
// TEST FIXTURES - Mock Research Outputs
// =============================================================================

/**
 * Good research output with proper statistical evidence.
 * Includes: objective, hypothesis, CI, effect size before finding,
 * baseline ML metrics, CV metrics, interpretation, and conclusion.
 */
const GOOD_RESEARCH_OUTPUT = `
[OBJECTIVE] Analyze customer churn patterns and build predictive model

[HYPOTHESIS] H0: Customer tenure has no effect on churn; H1: Longer tenure reduces churn

[EXPERIMENT] Used logistic regression with 5-fold stratified cross-validation

[DATA] Loaded 7,043 customers with 20 features

[METRIC:baseline_accuracy] 0.735
[METRIC:baseline_description] Majority class classifier

[CHECK:normality] Shapiro-Wilk p=0.23 - normality assumption OK for continuous features
[CHECK:homogeneity] Levene's p=0.12 - equal variances assumption satisfied

[DECISION] Using Welch's t-test for group comparisons due to unequal sample sizes

[STAT:estimate] mean_diff = 0.42
[STAT:ci] 95% CI [0.35, 0.49]
[STAT:effect_size] Cohen's d = 0.65 (medium effect)
[STAT:p_value] p = 0.0001

[FINDING] Customers with tenure > 24 months show 42% lower churn rate (d=0.65, 95% CI [0.35, 0.49])

[METRIC:cv_accuracy_mean] 0.87
[METRIC:cv_accuracy_std] 0.02
[METRIC:cv_auc_mean] 0.91

[METRIC:feature_importance] tenure (0.23), monthly_charges (0.18), contract_type (0.15)
[METRIC:top_features] tenure, monthly_charges, contract_type

[SO_WHAT] Targeting customers before the 24-month mark could reduce churn by 42%

[LIMITATION] Study limited to single telecom provider; may not generalize

[NEXT_STEP] Implement early intervention program for customers approaching 24-month mark

[CONCLUSION] Hypothesis confirmed - tenure significantly reduces churn with medium effect size
`;

/**
 * Shallow research output missing statistical evidence.
 * Findings without CI or effect size should be flagged.
 */
const SHALLOW_RESEARCH_OUTPUT = `
[OBJECTIVE] Analyze customer behavior

[DATA] Loaded customer data

[METRIC:accuracy] 0.85

[FINDING] Customers who buy more tend to be more loyal

[FINDING] Premium customers have higher satisfaction scores

[FINDING] Young customers prefer mobile apps

[CONCLUSION] Analysis complete
`;

/**
 * Mixed research output - some findings verified, some not.
 * Stats must be more than 10 lines apart from later findings.
 */
const MIXED_RESEARCH_OUTPUT = `
[OBJECTIVE] Comprehensive customer analysis

[HYPOTHESIS] H1: Age affects purchase patterns

[EXPERIMENT] Cross-sectional survey analysis

[STAT:ci] 95% CI [0.12, 0.28]
[STAT:effect_size] Cohen's d = 0.45 (small-medium)
[FINDING] Age group 25-34 shows higher purchase frequency (d=0.45, CI [0.12, 0.28])

Analysis of secondary variable continues...
Additional exploration of demographic factors...
Examining regional differences in purchase patterns...
Looking at seasonal variations in customer behavior...
Evaluating the impact of marketing campaigns...
Considering price sensitivity across segments...
Reviewing historical trends in the data...
Checking for anomalies in recent periods...
Validating data quality for income variable...

[STAT:ci] 95% CI [0.30, 0.55]
[FINDING] Income strongly predicts purchase amount (partial - missing effect size)

Moving on to tertiary analysis...
Exploring education-related patterns...
Examining product preference correlations...
Analyzing cross-tabulations...
Looking at preference intensity measures...
Evaluating category distributions...
Checking for demographic interactions...
Reviewing segment-specific patterns...
Validating the preference measurement approach...
Considering alternative explanations for patterns...

[FINDING] Education level correlates with product preference (exploratory - no stats)

[CONCLUSION] Age and income are significant predictors of purchase behavior
`;

/**
 * ML research missing required pipeline components.
 */
const INCOMPLETE_ML_RESEARCH = `
[OBJECTIVE] Build classification model

[DATA] Loaded training data

[METRIC:accuracy] 0.92
[METRIC:precision] 0.89
[METRIC:recall] 0.87

[FINDING] Model achieves 92% accuracy

[CONCLUSION] Model is production ready
`;

/**
 * Complete ML pipeline research.
 */
const COMPLETE_ML_RESEARCH = `
[OBJECTIVE] Build robust classification model

[HYPOTHESIS] H0: Model performs no better than baseline; H1: Model outperforms baseline

[EXPERIMENT] 5-fold stratified cross-validation with hyperparameter tuning

[METRIC:baseline_accuracy] 0.65
[METRIC:baseline_f1] 0.48

[METRIC:cv_accuracy_mean] 0.92
[METRIC:cv_accuracy_std] 0.02
[METRIC:cv_f1_mean] 0.89
[METRIC:cv_f1_std] 0.03

[METRIC:feature_importance] feature_a (0.25), feature_b (0.20), feature_c (0.15)

[STAT:ci] 95% CI [0.89, 0.95]
[STAT:effect_size] Improvement over baseline: 0.27 (27 percentage points)
[FINDING] Model significantly outperforms baseline (accuracy +27pp, 95% CI [0.89, 0.95])

[SO_WHAT] Model can reduce manual review workload by 65%

[LIMITATION] Training data from single time period; temporal drift not evaluated

[CONCLUSION] Model validated for production deployment
`;

/**
 * Research missing key IMRAD sections.
 */
const MISSING_IMRAD_SECTIONS = `
[DATA] Loaded some data

[METRIC:accuracy] 0.75

Some analysis was done here.

[NEXT_STEP] Do more analysis
`;

// =============================================================================
// TEST SUITE: Full Pipeline Integration
// =============================================================================

describe("Quality Gate Integration", () => {
  describe("Full pipeline with good research", () => {
    test("good research passes all gates with score 100", () => {
      const result = runQualityGates(GOOD_RESEARCH_OUTPUT);

      expect(result.passed).toBe(true);
      expect(result.score).toBe(100);
      expect(result.violations).toHaveLength(0);
    });

    test("good research has verified findings", () => {
      const result = runQualityGates(GOOD_RESEARCH_OUTPUT);

      expect(result.findingsValidation.total).toBeGreaterThan(0);
      expect(result.findingsValidation.verified).toBe(result.findingsValidation.total);
      expect(result.findingsValidation.unverified).toBe(0);
    });

    test("good research passes ML validation", () => {
      const result = runQualityGates(GOOD_RESEARCH_OUTPUT);

      expect(result.mlValidation.hasBaseline).toBe(true);
      expect(result.mlValidation.hasCV).toBe(true);
      expect(result.mlValidation.hasInterpretation).toBe(true);
    });

    test("complete ML research passes all gates", () => {
      const result = runQualityGates(COMPLETE_ML_RESEARCH);

      expect(result.passed).toBe(true);
      expect(result.score).toBe(100);
      expect(result.mlValidation.hasBaseline).toBe(true);
      expect(result.mlValidation.hasCV).toBe(true);
      expect(result.mlValidation.hasInterpretation).toBe(true);
    });
  });

  describe("Full pipeline with shallow research", () => {
    test("shallow research fails with multiple violations", () => {
      const result = runQualityGates(SHALLOW_RESEARCH_OUTPUT);

      expect(result.passed).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
    });

    test("shallow research has low score (downgraded to PARTIAL)", () => {
      const result = runQualityGates(SHALLOW_RESEARCH_OUTPUT);

      // Each unverified finding costs 60 points (30 for no CI + 30 for no effect_size)
      // 3 findings * 60 = 180 penalty, but also ML violations
      // Score should be 0 (capped at minimum)
      expect(result.score).toBeLessThanOrEqual(40);
      expect(result.passed).toBe(false);
    });

    test("shallow research identifies unverified findings", () => {
      const result = runQualityGates(SHALLOW_RESEARCH_OUTPUT);

      expect(result.findingsValidation.total).toBe(3);
      expect(result.findingsValidation.unverified).toBe(3);
      expect(result.findingsValidation.verified).toBe(0);
    });

    test("incomplete ML research triggers violations", () => {
      const result = runQualityGates(INCOMPLETE_ML_RESEARCH);

      expect(result.passed).toBe(false);

      // Should have ML violations
      const mlViolations = result.violations.filter(
        (v) =>
          v.type === "ML_NO_BASELINE" ||
          v.type === "ML_NO_CV" ||
          v.type === "ML_NO_INTERPRETATION"
      );
      expect(mlViolations.length).toBeGreaterThan(0);
    });
  });

  describe("Score calculation accuracy", () => {
    test("single finding without CI costs 30 points", () => {
      const text = `
[STAT:effect_size] Cohen's d = 0.5
[FINDING] Test finding
`;
      const result = runQualityGates(text);

      expect(result.score).toBe(70); // 100 - 30
    });

    test("single finding without effect size costs 30 points", () => {
      const text = `
[STAT:ci] 95% CI [0.1, 0.5]
[FINDING] Test finding
`;
      const result = runQualityGates(text);

      expect(result.score).toBe(70); // 100 - 30
    });

    test("single finding without any stats costs 60 points", () => {
      const text = `[FINDING] Test finding`;
      const result = runQualityGates(text);

      expect(result.score).toBe(40); // 100 - 30 - 30
    });

    test("ML without baseline costs 20 points", () => {
      const text = `
[METRIC:accuracy] 0.9
[METRIC:cv_accuracy_mean] 0.88
[METRIC:feature_importance] a: 0.5
`;
      const result = runQualityGates(text);

      // Only baseline is missing: -20
      expect(result.score).toBe(80);
    });

    test("ML without CV costs 25 points", () => {
      const text = `
[METRIC:accuracy] 0.9
[METRIC:baseline_accuracy] 0.65
[METRIC:feature_importance] a: 0.5
`;
      const result = runQualityGates(text);

      // Only CV is missing: -25
      expect(result.score).toBe(75);
    });

    test("ML without interpretation costs 15 points", () => {
      const text = `
[METRIC:accuracy] 0.9
[METRIC:baseline_accuracy] 0.65
[METRIC:cv_accuracy_mean] 0.88
`;
      const result = runQualityGates(text);

      // Only interpretation is missing: -15
      expect(result.score).toBe(85);
    });

    test("combined violations accumulate correctly", () => {
      const text = `
[METRIC:accuracy] 0.9
[FINDING] Unverified finding
`;
      const result = runQualityGates(text);

      // Finding: -30 (no CI) -30 (no effect_size) = -60
      // ML: -20 (no baseline) -25 (no CV) -15 (no interpretation) = -60
      // Total: -120, capped at 0
      expect(result.score).toBe(0);
    });
  });
});

// =============================================================================
// TEST SUITE: Finding Categorization
// =============================================================================

describe("Finding Categorization", () => {
  test("separateFindings categorizes verified findings correctly", () => {
    const parseResult = parseMarkers(GOOD_RESEARCH_OUTPUT);
    const { verified, partial, exploratory } = separateFindings(parseResult.markers);

    expect(verified.length).toBe(1);
    expect(partial.length).toBe(0);
    expect(exploratory.length).toBe(0);
  });

  test("separateFindings categorizes exploratory findings correctly", () => {
    const parseResult = parseMarkers(SHALLOW_RESEARCH_OUTPUT);
    const { verified, partial, exploratory } = separateFindings(parseResult.markers);

    expect(verified.length).toBe(0);
    expect(partial.length).toBe(0);
    expect(exploratory.length).toBe(3);
  });

  test("separateFindings handles mixed findings", () => {
    const parseResult = parseMarkers(MIXED_RESEARCH_OUTPUT);
    const { verified, partial, exploratory } = separateFindings(parseResult.markers);

    // First finding has both CI and effect_size -> verified
    expect(verified.length).toBe(1);
    expect(verified[0].content).toContain("Age group 25-34");

    // Second finding has only CI -> partial
    expect(partial.length).toBe(1);
    expect(partial[0].content).toContain("Income");

    // Third finding has no stats -> exploratory
    expect(exploratory.length).toBe(1);
    expect(exploratory[0].content).toContain("Education");
  });

  test("empty input returns empty categories", () => {
    const parseResult = parseMarkers("");
    const { verified, partial, exploratory } = separateFindings(parseResult.markers);

    expect(verified.length).toBe(0);
    expect(partial.length).toBe(0);
    expect(exploratory.length).toBe(0);
  });

  test("finding content is preserved in categorization", () => {
    const text = `
[STAT:ci] 95% CI [0.1, 0.5]
[STAT:effect_size] d = 0.7
[FINDING] Treatment shows significant improvement with large effect
`;
    const parseResult = parseMarkers(text);
    const { verified } = separateFindings(parseResult.markers);

    expect(verified.length).toBe(1);
    expect(verified[0].content).toBe("Treatment shows significant improvement with large effect");
  });
});

// =============================================================================
// TEST SUITE: IMRAD Section Validation
// =============================================================================

describe("IMRAD Section Validation", () => {
  test("complete research has all IMRAD sections", () => {
    const parseResult = parseMarkers(GOOD_RESEARCH_OUTPUT);
    const missing = validateIMRADSections(parseResult.markers);

    expect(missing.length).toBe(0);
  });

  test("missing sections are identified", () => {
    const parseResult = parseMarkers(MISSING_IMRAD_SECTIONS);
    const missing = validateIMRADSections(parseResult.markers);

    // Should be missing: OBJECTIVE, EXPERIMENT, FINDING, CONCLUSION
    expect(missing.length).toBe(4);

    const missingMarkers = missing.map((m) => m.marker);
    expect(missingMarkers).toContain("OBJECTIVE");
    expect(missingMarkers).toContain("EXPERIMENT");
    expect(missingMarkers).toContain("FINDING");
    expect(missingMarkers).toContain("CONCLUSION");
  });

  test("partial IMRAD compliance is detected", () => {
    const text = `
[OBJECTIVE] Test objective
[FINDING] Test finding
`;
    const parseResult = parseMarkers(text);
    const missing = validateIMRADSections(parseResult.markers);

    // Should be missing: EXPERIMENT (Methods), CONCLUSION
    expect(missing.length).toBe(2);

    const missingMarkers = missing.map((m) => m.marker);
    expect(missingMarkers).toContain("EXPERIMENT");
    expect(missingMarkers).toContain("CONCLUSION");
  });

  test("missing section descriptions are informative", () => {
    const parseResult = parseMarkers("");
    const missing = validateIMRADSections(parseResult.markers);

    // All sections should be missing
    expect(missing.length).toBe(4);

    // Each should have descriptive info
    for (const section of missing) {
      expect(section.marker).toBeDefined();
      expect(section.section).toBeDefined();
      expect(section.description).toBeDefined();
      expect(section.description.length).toBeGreaterThan(0);
    }
  });

  test("IMRAD validation includes section names", () => {
    const parseResult = parseMarkers("");
    const missing = validateIMRADSections(parseResult.markers);

    const sections = missing.map((m) => m.section);
    expect(sections).toContain("Introduction");
    expect(sections).toContain("Methods");
    expect(sections).toContain("Results");
    expect(sections).toContain("Conclusion");
  });
});

// =============================================================================
// TEST SUITE: Report Generation with Quality Gates
// =============================================================================

describe("Report Generation with Quality Gates", () => {
  test("report model includes separated findings", () => {
    const parseResult = parseMarkers(MIXED_RESEARCH_OUTPUT);
    const model = buildReportModel(undefined, parseResult.markers, []);

    expect(model.separatedFindings).toBeDefined();
    expect(model.separatedFindings!.verified.length).toBe(1);
    expect(model.separatedFindings!.partial.length).toBe(1);
    expect(model.separatedFindings!.exploratory.length).toBe(1);
  });

  test("report model includes missing sections", () => {
    const parseResult = parseMarkers(MISSING_IMRAD_SECTIONS);
    const model = buildReportModel(undefined, parseResult.markers, []);

    expect(model.missingSections).toBeDefined();
    expect(model.missingSections!.length).toBeGreaterThan(0);
  });

  test("rendered report has verified findings section", () => {
    const parseResult = parseMarkers(GOOD_RESEARCH_OUTPUT);
    const model = buildReportModel(undefined, parseResult.markers, []);
    const markdown = renderReportMarkdown(model);

    expect(markdown).toContain("## Key Findings (Verified)");
    expect(markdown).toContain("full statistical evidence");
  });

  test("rendered report has exploratory section when needed", () => {
    const parseResult = parseMarkers(SHALLOW_RESEARCH_OUTPUT);
    const model = buildReportModel(undefined, parseResult.markers, []);
    const markdown = renderReportMarkdown(model);

    expect(markdown).toContain("## Exploratory Observations");
    expect(markdown).toContain("lack full statistical evidence");
  });

  test("rendered report shows missing IMRAD sections", () => {
    const parseResult = parseMarkers(MISSING_IMRAD_SECTIONS);
    const model = buildReportModel(undefined, parseResult.markers, []);
    const markdown = renderReportMarkdown(model);

    expect(markdown).toContain("## Missing IMRAD Sections");
    expect(markdown).toContain("[SECTION MISSING:");
  });

  test("complete research report omits missing sections warning", () => {
    const parseResult = parseMarkers(GOOD_RESEARCH_OUTPUT);
    const model = buildReportModel(undefined, parseResult.markers, []);
    const markdown = renderReportMarkdown(model);

    expect(markdown).not.toContain("## Missing IMRAD Sections");
    expect(markdown).not.toContain("[SECTION MISSING:");
  });

  test("report correctly categorizes partial findings", () => {
    const parseResult = parseMarkers(MIXED_RESEARCH_OUTPUT);
    const model = buildReportModel(undefined, parseResult.markers, []);
    const markdown = renderReportMarkdown(model);

    expect(markdown).toContain("## Findings (Partial Evidence)");
    expect(markdown).toContain("partial statistical evidence");
  });
});

// =============================================================================
// TEST SUITE: Edge Cases
// =============================================================================

describe("Quality Gate Edge Cases", () => {
  test("empty output passes with score 100", () => {
    const result = runQualityGates("");

    expect(result.passed).toBe(true);
    expect(result.score).toBe(100);
  });

  test("output with only text (no markers) passes", () => {
    const text = `
This is just regular text.
No markers here at all.
Just prose and analysis.
`;
    const result = runQualityGates(text);

    expect(result.passed).toBe(true);
    expect(result.score).toBe(100);
  });

  test("stats after finding are not counted", () => {
    const text = `
[FINDING] Finding before stats
[STAT:ci] 95% CI [0.1, 0.5]
[STAT:effect_size] d = 0.5
`;
    const result = runQualityGates(text);

    // Stats come AFTER the finding, so it should fail
    expect(result.passed).toBe(false);
    expect(result.findingsValidation.unverified).toBe(1);
  });

  test("stats too far before finding are not counted", () => {
    // Create text where stats are more than 10 lines before finding
    const lines = [
      "[STAT:ci] 95% CI [0.1, 0.5]",
      "[STAT:effect_size] d = 0.5",
      ...Array(15).fill("filler line"),
      "[FINDING] Finding too far from stats",
    ];
    const text = lines.join("\n");
    const result = runQualityGates(text);

    // Stats are more than 10 lines away
    expect(result.passed).toBe(false);
    expect(result.findingsValidation.unverified).toBe(1);
  });

  test("multiple findings with shared stats before them", () => {
    const text = `
[STAT:ci] 95% CI [0.1, 0.5]
[STAT:effect_size] d = 0.5
[FINDING] First finding - should be verified
[FINDING] Second finding - stats still within 10 lines
`;
    const result = runQualityGates(text);

    // Both findings should be verified (stats within 10 lines)
    expect(result.findingsValidation.total).toBe(2);
    expect(result.findingsValidation.verified).toBe(2);
    expect(result.passed).toBe(true);
  });

  test("non-ML research does not trigger ML violations", () => {
    const text = `
[OBJECTIVE] Conduct survey analysis
[HYPOTHESIS] H1: Satisfaction varies by region
[STAT:ci] 95% CI [0.2, 0.6]
[STAT:effect_size] d = 0.4
[FINDING] Regional differences observed
[CONCLUSION] Hypothesis supported
`;
    const result = runQualityGates(text);

    // No ML metrics, so no ML violations should occur
    expect(result.passed).toBe(true);
    expect(result.score).toBe(100);
    expect(result.mlValidation.hasBaseline).toBe(false);
    expect(result.mlValidation.hasCV).toBe(false);
    expect(result.mlValidation.hasInterpretation).toBe(false);

    // But no violations because no ML metrics trigger the validation
    const mlViolations = result.violations.filter(
      (v) => v.type.startsWith("ML_")
    );
    expect(mlViolations.length).toBe(0);
  });
});
