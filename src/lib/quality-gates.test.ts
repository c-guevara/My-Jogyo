import { describe, expect, test } from "bun:test";
import {
  validateFindings,
  validateMLPipeline,
  runQualityGates,
  type QualityViolation,
} from "./quality-gates";
import { parseMarkers } from "./marker-parser";

describe("quality-gates", () => {
  describe("validateFindings", () => {
    test("finding with CI and effect size passes", () => {
      const text = `
[STAT:ci] 95% CI [0.12, 0.58]
[STAT:effect_size] Cohen's d = 0.45
[FINDING] Treatment group shows improvement
`;
      const result = validateFindings(text);

      expect(result.violations.length).toBe(0);
      expect(result.validation.total).toBe(1);
      expect(result.validation.verified).toBe(1);
      expect(result.validation.unverified).toBe(0);
    });

    test("finding without CI fails with penalty", () => {
      const text = `
[STAT:effect_size] Cohen's d = 0.45
[FINDING] Treatment group shows improvement
`;
      const result = validateFindings(text);

      expect(result.violations.length).toBe(1);
      expect(result.violations[0].type).toBe("FINDING_NO_CI");
      expect(result.violations[0].penalty).toBe(30);
      expect(result.validation.total).toBe(1);
      expect(result.validation.verified).toBe(0);
      expect(result.validation.unverified).toBe(1);
    });

    test("finding without effect size fails", () => {
      const text = `
[STAT:ci] 95% CI [0.12, 0.58]
[FINDING] Treatment group shows improvement
`;
      const result = validateFindings(text);

      expect(result.violations.length).toBe(1);
      expect(result.violations[0].type).toBe("FINDING_NO_EFFECT_SIZE");
      expect(result.violations[0].penalty).toBe(30);
      expect(result.validation.verified).toBe(0);
      expect(result.validation.unverified).toBe(1);
    });

    test("finding without any stats fails with both penalties", () => {
      const text = `
[FINDING] Treatment group shows improvement
`;
      const result = validateFindings(text);

      expect(result.violations.length).toBe(2);
      const types = result.violations.map((v) => v.type);
      expect(types).toContain("FINDING_NO_CI");
      expect(types).toContain("FINDING_NO_EFFECT_SIZE");

      const totalPenalty = result.violations.reduce((sum, v) => sum + v.penalty, 0);
      expect(totalPenalty).toBe(60);
      expect(result.validation.unverified).toBe(1);
    });

    test("stats must be within 10 lines before finding", () => {
      // CI is 12 lines before the finding (line 14), exceeding the 10-line lookback
      const text = `Line 1
[STAT:ci] 95% CI [0.12, 0.58]
Line 3
Line 4
Line 5
Line 6
Line 7
Line 8
Line 9
Line 10
Line 11
Line 12
Line 13
[FINDING] Treatment group shows improvement
`;
      const result = validateFindings(text);

      // CI is too far away, should fail
      const ciViolation = result.violations.find((v) => v.type === "FINDING_NO_CI");
      expect(ciViolation).toBeDefined();
      expect(result.validation.unverified).toBe(1);
    });

    test("stats within exactly 10 lines passes", () => {
      // CI at line 2, Finding at line 12 = 10 lines difference (within limit)
      const text = `Line 1
[STAT:ci] 95% CI [0.12, 0.58]
[STAT:effect_size] Cohen's d = 0.45
Line 4
Line 5
Line 6
Line 7
Line 8
Line 9
Line 10
Line 11
[FINDING] Treatment group shows improvement
`;
      const result = validateFindings(text);

      expect(result.violations.length).toBe(0);
      expect(result.validation.verified).toBe(1);
    });

    test("multiple findings with mixed verification status", () => {
      const text = `
[STAT:ci] 95% CI [0.12, 0.58]
[STAT:effect_size] Cohen's d = 0.45
[FINDING] First finding - properly verified
Line 5
Line 6
Line 7
Line 8
Line 9
Line 10
Line 11
Line 12
Line 13
Line 14
Line 15
[FINDING] Second finding - missing stats (far from first stats)

[STAT:ci] 95% CI [0.20, 0.40]
[STAT:effect_size] Cohen's d = 0.30
[FINDING] Third finding - properly verified
`;
      const result = validateFindings(text);

      expect(result.validation.total).toBe(3);
      expect(result.validation.verified).toBe(2);
      expect(result.validation.unverified).toBe(1);
      expect(result.violations.length).toBe(2);
    });

    test("hyphenated subtypes are normalized and work with quality gates", () => {
      const text = `
[STAT:ci] 95% CI [0.82, 0.94]
[STAT:effect-size] Cohen's d = 0.75 (medium)
[FINDING] Treatment shows significant effect
`;
      const result = validateFindings(text);

      expect(result.violations.length).toBe(0);
      expect(result.validation.total).toBe(1);
      expect(result.validation.verified).toBe(1);
    });

    test("no findings returns empty violations", () => {
      const text = `
[OBJECTIVE] Analyze data
[STAT:ci] 95% CI [0.12, 0.58]
[CONCLUSION] All done
`;
      const result = validateFindings(text);

      expect(result.violations.length).toBe(0);
      expect(result.validation.total).toBe(0);
      expect(result.validation.verified).toBe(0);
      expect(result.validation.unverified).toBe(0);
    });

    test("violation includes line number and content", () => {
      const text = `[FINDING] Unverified finding`;
      const result = validateFindings(text);

      expect(result.violations.length).toBe(2);
      result.violations.forEach((v) => {
        expect(v.lineNumber).toBe(1);
        expect(v.content).toBe("Unverified finding");
        expect(v.message).toContain("line 1");
      });
    });
  });

  describe("validateMLPipeline", () => {
    test("complete ML pipeline passes", () => {
      const text = `
[METRIC:baseline_accuracy] 0.33
[METRIC:cv_accuracy_mean] 0.87
[METRIC:cv_accuracy_std] 0.03
[METRIC:feature_importance] age: 0.23, income: 0.18
`;
      const parseResult = parseMarkers(text);
      const result = validateMLPipeline(parseResult.markers);

      expect(result.violations.length).toBe(0);
      expect(result.validation.hasBaseline).toBe(true);
      expect(result.validation.hasCV).toBe(true);
      expect(result.validation.hasInterpretation).toBe(true);
    });

    test("missing baseline fails", () => {
      const text = `
[METRIC:accuracy] 0.87
[METRIC:cv_accuracy_mean] 0.85
[METRIC:feature_importance] age: 0.23
`;
      const parseResult = parseMarkers(text);
      const result = validateMLPipeline(parseResult.markers);

      expect(result.validation.hasBaseline).toBe(false);
      const baselineViolation = result.violations.find(
        (v) => v.type === "ML_NO_BASELINE"
      );
      expect(baselineViolation).toBeDefined();
      expect(baselineViolation?.penalty).toBe(20);
    });

    test("missing CV fails", () => {
      const text = `
[METRIC:accuracy] 0.87
[METRIC:baseline_accuracy] 0.33
[METRIC:top_features] age, income, tenure
`;
      const parseResult = parseMarkers(text);
      const result = validateMLPipeline(parseResult.markers);

      expect(result.validation.hasCV).toBe(false);
      const cvViolation = result.violations.find((v) => v.type === "ML_NO_CV");
      expect(cvViolation).toBeDefined();
      expect(cvViolation?.penalty).toBe(25);
    });

    test("missing interpretation fails", () => {
      const text = `
[METRIC:accuracy] 0.87
[METRIC:baseline_accuracy] 0.33
[METRIC:cv_accuracy_mean] 0.85
`;
      const parseResult = parseMarkers(text);
      const result = validateMLPipeline(parseResult.markers);

      expect(result.validation.hasInterpretation).toBe(false);
      const interpViolation = result.violations.find(
        (v) => v.type === "ML_NO_INTERPRETATION"
      );
      expect(interpViolation).toBeDefined();
      expect(interpViolation?.penalty).toBe(15);
    });

    test("non-ML research does not generate ML violations", () => {
      const text = `
[OBJECTIVE] Analyze survey results
[DATA] Loaded survey.csv
[STAT:ci] 95% CI [0.12, 0.58]
[FINDING] Significant difference found
`;
      const parseResult = parseMarkers(text);
      const result = validateMLPipeline(parseResult.markers);

      // No ML metrics → no ML violations
      expect(result.violations.length).toBe(0);
      expect(result.validation.hasBaseline).toBe(false);
      expect(result.validation.hasCV).toBe(false);
      expect(result.validation.hasInterpretation).toBe(false);
    });

    test("detects various ML metric types", () => {
      // Test that various ML metrics trigger validation
      const metricsToTest = [
        "[METRIC:precision] 0.85",
        "[METRIC:recall] 0.80",
        "[METRIC:f1] 0.82",
        "[METRIC:auc] 0.91",
        "[METRIC:rmse] 0.15",
        "[METRIC:mae] 0.12",
        "[METRIC:r2] 0.78",
        "[METRIC:mse] 0.023",
      ];

      for (const metric of metricsToTest) {
        const text = `${metric}`;
        const parseResult = parseMarkers(text);
        const result = validateMLPipeline(parseResult.markers);

        // Each should trigger ML validation (and thus violations for missing baseline/cv/interp)
        expect(result.violations.length).toBeGreaterThan(0);
      }
    });

    test("accepts various interpretation marker types", () => {
      const interpretationMarkers = [
        "[METRIC:shap_values] feature1: 0.5, feature2: 0.3",
        "[METRIC:permutation_importance] feature1: 0.4",
        "[METRIC:top_features] age, income",
      ];

      for (const interpMarker of interpretationMarkers) {
        const text = `
[METRIC:accuracy] 0.87
[METRIC:baseline_accuracy] 0.33
[METRIC:cv_accuracy_mean] 0.85
${interpMarker}
`;
        const parseResult = parseMarkers(text);
        const result = validateMLPipeline(parseResult.markers);

        expect(result.validation.hasInterpretation).toBe(true);
      }
    });
  });

  describe("runQualityGates", () => {
    test("perfect research scores 100", () => {
      const text = `
[OBJECTIVE] Analyze treatment effect
[HYPOTHESIS] H0: no effect; H1: treatment improves outcome
[STAT:ci] 95% CI [0.12, 0.58]
[STAT:effect_size] Cohen's d = 0.45
[FINDING] Treatment shows significant improvement
[CONCLUSION] Hypothesis confirmed
`;
      const result = runQualityGates(text);

      expect(result.passed).toBe(true);
      expect(result.score).toBe(100);
      expect(result.violations.length).toBe(0);
      expect(result.findingsValidation.verified).toBe(1);
    });

    test("one finding without CI scores 70", () => {
      const text = `
[STAT:effect_size] Cohen's d = 0.45
[FINDING] Treatment shows improvement
`;
      const result = runQualityGates(text);

      expect(result.passed).toBe(false);
      expect(result.score).toBe(70); // 100 - 30
      expect(result.violations.length).toBe(1);
      expect(result.violations[0].type).toBe("FINDING_NO_CI");
    });

    test("one finding without effect size scores 70", () => {
      const text = `
[STAT:ci] 95% CI [0.12, 0.58]
[FINDING] Treatment shows improvement
`;
      const result = runQualityGates(text);

      expect(result.passed).toBe(false);
      expect(result.score).toBe(70); // 100 - 30
      expect(result.violations[0].type).toBe("FINDING_NO_EFFECT_SIZE");
    });

    test("score minimum is 0 with many violations", () => {
      // 4 findings without any stats = 4 * (30 + 30) = 240 penalty
      const text = `
[FINDING] First unverified
[FINDING] Second unverified
[FINDING] Third unverified
[FINDING] Fourth unverified
`;
      const result = runQualityGates(text);

      expect(result.passed).toBe(false);
      expect(result.score).toBe(0); // Minimum is 0, not negative
      expect(result.violations.length).toBe(8); // 4 findings * 2 violations each
    });

    test("combines finding and ML violations", () => {
      // Finding without stats + ML without baseline/cv/interpretation
      const text = `
[METRIC:accuracy] 0.87
[FINDING] Model performs well
`;
      const result = runQualityGates(text);

      expect(result.passed).toBe(false);
      // Finding: -30 (no CI) -30 (no effect size) = -60
      // ML: -20 (no baseline) -25 (no CV) -15 (no interpretation) = -60
      // Total: -120, score = max(0, 100-120) = 0
      expect(result.score).toBe(0);
      expect(result.violations.length).toBe(5);
    });

    test("empty text passes with score 100", () => {
      const text = "";
      const result = runQualityGates(text);

      expect(result.passed).toBe(true);
      expect(result.score).toBe(100);
      expect(result.violations.length).toBe(0);
    });

    test("text without markers passes with score 100", () => {
      const text = `
This is just regular text
without any markers.
No findings, no ML metrics.
`;
      const result = runQualityGates(text);

      expect(result.passed).toBe(true);
      expect(result.score).toBe(100);
      expect(result.violations.length).toBe(0);
    });

    test("complete ML pipeline with verified finding scores 100", () => {
      const text = `
[OBJECTIVE] Build classification model
[METRIC:baseline_accuracy] 0.33
[METRIC:cv_accuracy_mean] 0.87
[METRIC:cv_accuracy_std] 0.03
[METRIC:feature_importance] age: 0.23, income: 0.18
[STAT:ci] 95% CI [0.82, 0.92]
[STAT:effect_size] Improvement over baseline: 0.54
[FINDING] Model outperforms baseline by 54 points
[CONCLUSION] Classification successful
`;
      const result = runQualityGates(text);

      expect(result.passed).toBe(true);
      expect(result.score).toBe(100);
      expect(result.findingsValidation.verified).toBe(1);
      expect(result.mlValidation.hasBaseline).toBe(true);
      expect(result.mlValidation.hasCV).toBe(true);
      expect(result.mlValidation.hasInterpretation).toBe(true);
    });

    test("score calculation accuracy for partial violations", () => {
      // ML pipeline with baseline but missing CV and interpretation
      // -25 (no CV) -15 (no interpretation) = -40
      const text = `
[METRIC:accuracy] 0.87
[METRIC:baseline_accuracy] 0.33
`;
      const result = runQualityGates(text);

      expect(result.score).toBe(60); // 100 - 25 - 15 = 60
      expect(result.violations.length).toBe(2);
    });
  });
});
