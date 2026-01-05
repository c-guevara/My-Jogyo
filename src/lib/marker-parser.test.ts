import { describe, expect, test } from 'bun:test';
import {
  parseMarkers,
  getMarkerDefinition,
  getMarkersByType,
  getMarkersByCategory,
  MARKER_TAXONOMY,
} from './marker-parser';

describe('marker-parser', () => {
  describe('MARKER_TAXONOMY', () => {
    test('includes STAGE marker', () => {
      expect(MARKER_TAXONOMY.STAGE).toBeDefined();
      expect(MARKER_TAXONOMY.STAGE.category).toBe('WORKFLOW');
    });

    test('includes CHECKPOINT marker', () => {
      expect(MARKER_TAXONOMY.CHECKPOINT).toBeDefined();
      expect(MARKER_TAXONOMY.CHECKPOINT.category).toBe('WORKFLOW');
    });

    test('includes REHYDRATED marker', () => {
      expect(MARKER_TAXONOMY.REHYDRATED).toBeDefined();
      expect(MARKER_TAXONOMY.REHYDRATED.category).toBe('WORKFLOW');
    });

    // Phase 2 Quality Gate markers
    test('STAT marker has subtype documentation', () => {
      expect(MARKER_TAXONOMY.STAT).toBeDefined();
      expect(MARKER_TAXONOMY.STAT.category).toBe('CALCULATIONS');
      expect(MARKER_TAXONOMY.STAT.description).toContain('ci');
      expect(MARKER_TAXONOMY.STAT.description).toContain('effect_size');
      expect(MARKER_TAXONOMY.STAT.description).toContain('p_value');
      expect(MARKER_TAXONOMY.STAT.description).toContain('estimate');
    });

    test('CHECK marker has assumption subtype documentation', () => {
      expect(MARKER_TAXONOMY.CHECK).toBeDefined();
      expect(MARKER_TAXONOMY.CHECK.category).toBe('WORKFLOW');
      expect(MARKER_TAXONOMY.CHECK.description).toContain('normality');
      expect(MARKER_TAXONOMY.CHECK.description).toContain('homogeneity');
      expect(MARKER_TAXONOMY.CHECK.description).toContain('independence');
    });

    test('DECISION marker mentions test selection', () => {
      expect(MARKER_TAXONOMY.DECISION).toBeDefined();
      expect(MARKER_TAXONOMY.DECISION.category).toBe('SCIENTIFIC');
      expect(MARKER_TAXONOMY.DECISION.description).toContain('test selection');
    });

    test('includes SO_WHAT marker', () => {
      expect(MARKER_TAXONOMY.SO_WHAT).toBeDefined();
      expect(MARKER_TAXONOMY.SO_WHAT.category).toBe('SCIENTIFIC');
      expect(MARKER_TAXONOMY.SO_WHAT.description).toContain('Practical significance');
    });

    test('includes INDEPENDENT_CHECK marker', () => {
      expect(MARKER_TAXONOMY.INDEPENDENT_CHECK).toBeDefined();
      expect(MARKER_TAXONOMY.INDEPENDENT_CHECK.category).toBe('SCIENTIFIC');
      expect(MARKER_TAXONOMY.INDEPENDENT_CHECK.description).toContain('Robustness');
    });

    test('includes CHALLENGE_RESPONSE marker', () => {
      expect(MARKER_TAXONOMY.CHALLENGE_RESPONSE).toBeDefined();
      expect(MARKER_TAXONOMY.CHALLENGE_RESPONSE.category).toBe('SCIENTIFIC');
      expect(MARKER_TAXONOMY.CHALLENGE_RESPONSE.description).toContain('adversarial');
    });

    test('includes VERIFICATION_CODE marker', () => {
      expect(MARKER_TAXONOMY.VERIFICATION_CODE).toBeDefined();
      expect(MARKER_TAXONOMY.VERIFICATION_CODE.category).toBe('SCIENTIFIC');
      expect(MARKER_TAXONOMY.VERIFICATION_CODE.description).toContain('Reproducible');
    });

    test('includes CITATION marker with format documentation', () => {
      expect(MARKER_TAXONOMY.CITATION).toBeDefined();
      expect(MARKER_TAXONOMY.CITATION.category).toBe('SCIENTIFIC');
      expect(MARKER_TAXONOMY.CITATION.description).toContain('DOI');
      expect(MARKER_TAXONOMY.CITATION.description).toContain('arXiv');
    });
  });

  describe('parseMarkers', () => {
    test('parses basic markers', () => {
      const text = `[OBJECTIVE] Analyze customer churn`;
      const result = parseMarkers(text);
      
      expect(result.markers.length).toBe(1);
      expect(result.markers[0].type).toBe('OBJECTIVE');
      expect(result.markers[0].content).toBe('Analyze customer churn');
      expect(result.markers[0].valid).toBe(true);
    });

    test('parses markers with leading whitespace', () => {
      const text = `  [FINDING] Result with leading spaces`;
      const result = parseMarkers(text);
      
      expect(result.markers.length).toBe(1);
      expect(result.markers[0].type).toBe('FINDING');
      expect(result.markers[0].content).toBe('Result with leading spaces');
      expect(result.markers[0].valid).toBe(true);
    });

    test('parses markers with tab indentation', () => {
      const text = `\t[STAT:ci] 95% CI [0.82, 0.94]`;
      const result = parseMarkers(text);
      
      expect(result.markers.length).toBe(1);
      expect(result.markers[0].type).toBe('STAT');
      expect(result.markers[0].subtype).toBe('ci');
      expect(result.markers[0].valid).toBe(true);
    });

    test('parses STAGE marker with subtype and attributes', () => {
      const text = `[STAGE:begin:id=S01_load_data] Loading dataset`;
      const result = parseMarkers(text);
      
      expect(result.markers.length).toBe(1);
      expect(result.markers[0].type).toBe('STAGE');
      expect(result.markers[0].subtype).toBe('begin');
      expect(result.markers[0].attributes.id).toBe('S01_load_data');
      expect(result.markers[0].content).toBe('Loading dataset');
      expect(result.markers[0].valid).toBe(true);
    });

    test('parses STAGE:end marker', () => {
      const text = `[STAGE:end:id=S01_load_data:duration=45s] Data loaded successfully`;
      const result = parseMarkers(text);
      
      expect(result.markers.length).toBe(1);
      expect(result.markers[0].type).toBe('STAGE');
      expect(result.markers[0].subtype).toBe('end');
      expect(result.markers[0].attributes.id).toBe('S01_load_data');
      expect(result.markers[0].attributes.duration).toBe('45s');
    });

    test('parses CHECKPOINT:saved marker with all attributes', () => {
      const text = `[CHECKPOINT:saved:id=ckpt-001:stage=S02_eda:runId=run-001] Checkpoint saved`;
      const result = parseMarkers(text);
      
      expect(result.markers.length).toBe(1);
      expect(result.markers[0].type).toBe('CHECKPOINT');
      expect(result.markers[0].subtype).toBe('saved');
      expect(result.markers[0].attributes.id).toBe('ckpt-001');
      expect(result.markers[0].attributes.stage).toBe('S02_eda');
      expect(result.markers[0].attributes.runId).toBe('run-001');
      expect(result.markers[0].valid).toBe(true);
    });

    test('parses CHECKPOINT:emergency marker', () => {
      const text = `[CHECKPOINT:emergency:id=ckpt-002:reason=watchdog_timeout] Emergency save`;
      const result = parseMarkers(text);
      
      expect(result.markers.length).toBe(1);
      expect(result.markers[0].type).toBe('CHECKPOINT');
      expect(result.markers[0].subtype).toBe('emergency');
      expect(result.markers[0].attributes.reason).toBe('watchdog_timeout');
    });

    test('parses REHYDRATED marker', () => {
      const text = `[REHYDRATED:from=ckpt-001] Session restored from checkpoint`;
      const result = parseMarkers(text);
      
      expect(result.markers.length).toBe(1);
      expect(result.markers[0].type).toBe('REHYDRATED');
      expect(result.markers[0].attributes.from).toBe('ckpt-001');
    });

    test('parses multiple stage markers in workflow', () => {
      const text = `
[STAGE:begin:id=S01_load_data] Loading dataset
[DATA] Loaded customers.csv
[SHAPE] 10000 rows, 15 columns
[STAGE:end:id=S01_load_data:duration=30s] Complete
[CHECKPOINT:saved:id=ckpt-001:stage=S01_load_data] Checkpoint saved
[STAGE:begin:id=S02_eda] Starting exploratory analysis
`;
      const result = parseMarkers(text);
      
      expect(result.markers.length).toBe(6);
      expect(result.validCount).toBe(6);
      
      const stageMarkers = getMarkersByType(result.markers, 'STAGE');
      expect(stageMarkers.length).toBe(3);
      
      const checkpointMarkers = getMarkersByType(result.markers, 'CHECKPOINT');
      expect(checkpointMarkers.length).toBe(1);
    });

    test('tracks unknown markers', () => {
      const text = `[UNKNOWN_MARKER] Some content`;
      const result = parseMarkers(text);
      
      expect(result.markers.length).toBe(1);
      expect(result.markers[0].valid).toBe(false);
      expect(result.unknownCount).toBe(1);
      expect(result.unknownTypes).toContain('UNKNOWN_MARKER');
    });

    test('parses STAT with subtypes', () => {
      const text = `
[STAT:ci] 95% CI [0.82, 0.94]
[STAT:effect_size] Cohen's d = 0.75 (medium)
[STAT:p_value] p = 0.003
[STAT:estimate] mean_diff = 0.15
`;
      const result = parseMarkers(text);
      
      expect(result.markers.length).toBe(4);
      expect(result.validCount).toBe(4);
      
      const statMarkers = getMarkersByType(result.markers, 'STAT');
      expect(statMarkers.length).toBe(4);
      expect(statMarkers[0].subtype).toBe('ci');
      expect(statMarkers[1].subtype).toBe('effect_size');
      expect(statMarkers[2].subtype).toBe('p_value');
      expect(statMarkers[3].subtype).toBe('estimate');
    });

    test('parses CHECK with assumption subtypes', () => {
      const text = `
[CHECK:normality] Shapiro-Wilk p=0.23 - normality assumption OK
[CHECK:homogeneity] Levene's p=0.04 - using Welch's
[CHECK:independence] Durbin-Watson = 2.01 - no autocorrelation
`;
      const result = parseMarkers(text);
      
      expect(result.markers.length).toBe(3);
      expect(result.validCount).toBe(3);
      
      const checkMarkers = getMarkersByType(result.markers, 'CHECK');
      expect(checkMarkers[0].subtype).toBe('normality');
      expect(checkMarkers[1].subtype).toBe('homogeneity');
      expect(checkMarkers[2].subtype).toBe('independence');
    });

    test('parses SO_WHAT marker', () => {
      const text = `[SO_WHAT] This effect translates to $50K annual savings per customer segment`;
      const result = parseMarkers(text);
      
      expect(result.markers.length).toBe(1);
      expect(result.markers[0].type).toBe('SO_WHAT');
      expect(result.markers[0].valid).toBe(true);
      expect(result.markers[0].content).toContain('$50K');
    });

    test('parses INDEPENDENT_CHECK marker', () => {
      const text = `[INDEPENDENT_CHECK] Bootstrap 95% CI: [0.12, 0.28] - consistent with parametric`;
      const result = parseMarkers(text);
      
      expect(result.markers.length).toBe(1);
      expect(result.markers[0].type).toBe('INDEPENDENT_CHECK');
      expect(result.markers[0].valid).toBe(true);
    });

    test('parses CHALLENGE_RESPONSE marker with number', () => {
      const text = `[CHALLENGE_RESPONSE:1] Re-verified correlation with alternative method`;
      const result = parseMarkers(text);
      
      expect(result.markers.length).toBe(1);
      expect(result.markers[0].type).toBe('CHALLENGE_RESPONSE');
      expect(result.markers[0].subtype).toBe('1');
      expect(result.markers[0].valid).toBe(true);
    });

    test('parses VERIFICATION_CODE marker', () => {
      const text = `[VERIFICATION_CODE] df['accuracy'].mean() == 0.95`;
      const result = parseMarkers(text);
      
      expect(result.markers.length).toBe(1);
      expect(result.markers[0].type).toBe('VERIFICATION_CODE');
      expect(result.markers[0].valid).toBe(true);
    });

    test('normalizes hyphenated markers to underscore form', () => {
      const text = `[CHALLENGE-RESPONSE:1] Re-verified correlation`;
      const result = parseMarkers(text);
      
      expect(result.markers.length).toBe(1);
      expect(result.markers[0].type).toBe('CHALLENGE_RESPONSE');
      expect(result.markers[0].subtype).toBe('1');
      expect(result.markers[0].valid).toBe(true);
    });

    test('normalizes VERIFICATION-CODE to VERIFICATION_CODE', () => {
      const text = `[VERIFICATION-CODE] df['accuracy'].mean() == 0.95`;
      const result = parseMarkers(text);
      
      expect(result.markers.length).toBe(1);
      expect(result.markers[0].type).toBe('VERIFICATION_CODE');
      expect(result.markers[0].valid).toBe(true);
    });

    test('normalizes INDEPENDENT-CHECK to INDEPENDENT_CHECK', () => {
      const text = `[INDEPENDENT-CHECK] 5-fold CV confirms accuracy`;
      const result = parseMarkers(text);
      
      expect(result.markers.length).toBe(1);
      expect(result.markers[0].type).toBe('INDEPENDENT_CHECK');
      expect(result.markers[0].valid).toBe(true);
    });

    test('normalizes hyphenated subtypes to underscores (effect-size → effect_size)', () => {
      const text = `[STAT:effect-size] Cohen's d = 0.75 (medium)`;
      const result = parseMarkers(text);
      
      expect(result.markers.length).toBe(1);
      expect(result.markers[0].type).toBe('STAT');
      expect(result.markers[0].subtype).toBe('effect_size');
      expect(result.markers[0].valid).toBe(true);
    });

    test('normalizes hyphenated subtypes with multiple hyphens (p-value → p_value)', () => {
      const text = `[STAT:p-value] p = 0.003`;
      const result = parseMarkers(text);
      
      expect(result.markers.length).toBe(1);
      expect(result.markers[0].type).toBe('STAT');
      expect(result.markers[0].subtype).toBe('p_value');
      expect(result.markers[0].valid).toBe(true);
    });

    test('parses DECISION marker', () => {
      const text = `[DECISION] Using Welch's t-test: two independent groups, unequal variance`;
      const result = parseMarkers(text);
      
      expect(result.markers.length).toBe(1);
      expect(result.markers[0].type).toBe('DECISION');
      expect(result.markers[0].valid).toBe(true);
    });

    test('parses CITATION marker with DOI', () => {
      const text = `[CITATION:10.1145/2939672.2939785] XGBoost reference`;
      const result = parseMarkers(text);
      
      expect(result.markers.length).toBe(1);
      expect(result.markers[0].type).toBe('CITATION');
      expect(result.markers[0].subtype).toBe('10.1145/2939672.2939785');
      expect(result.markers[0].content).toBe('XGBoost reference');
      expect(result.markers[0].valid).toBe(true);
    });

    test('parses CITATION marker with arXiv ID', () => {
      const text = `[CITATION:2301.12345] Transformer paper`;
      const result = parseMarkers(text);
      
      expect(result.markers.length).toBe(1);
      expect(result.markers[0].type).toBe('CITATION');
      expect(result.markers[0].subtype).toBe('2301.12345');
      expect(result.markers[0].content).toBe('Transformer paper');
      expect(result.markers[0].valid).toBe(true);
    });

    test('parses CITATION marker with arXiv prefix containing colon', () => {
      const text = `[CITATION:arXiv:2301.12345] Transformer paper`;
      const result = parseMarkers(text);
      
      expect(result.markers.length).toBe(1);
      expect(result.markers[0].type).toBe('CITATION');
      expect(result.markers[0].subtype).toBe('arXiv:2301.12345');
      expect(result.markers[0].attributes).toEqual({});
      expect(result.markers[0].content).toBe('Transformer paper');
      expect(result.markers[0].valid).toBe(true);
    });

    test('parses CITATION with DOI containing multiple colons', () => {
      const text = `[CITATION:doi:10.1145/2939672.2939785] XGBoost paper`;
      const result = parseMarkers(text);
      
      expect(result.markers.length).toBe(1);
      expect(result.markers[0].type).toBe('CITATION');
      expect(result.markers[0].subtype).toBe('doi:10.1145/2939672.2939785');
      expect(result.markers[0].attributes).toEqual({});
      expect(result.markers[0].valid).toBe(true);
    });

    test('parses research workflow with new quality markers', () => {
      const text = `
[HYPOTHESIS] H0: No difference between groups; H1: Treatment > Control
[DECISION] Using Welch's t-test for independent samples
[CHECK:normality] Shapiro-Wilk p=0.23 - OK
[STAT:estimate] mean_diff = 0.45
[STAT:ci] 95% CI [0.20, 0.70]
[STAT:effect_size] Cohen's d = 0.75 (medium)
[STAT:p_value] p = 0.003
[INDEPENDENT_CHECK] Mann-Whitney U confirms (p=0.004)
[FINDING] Treatment shows significant medium effect
[SO_WHAT] Effect translates to 15% improvement in retention
[LIMITATION] Sample from single region
`;
      const result = parseMarkers(text);
      
      expect(result.markers.length).toBe(11);
      expect(result.validCount).toBe(11);
      
      const scientificMarkers = getMarkersByCategory(result.markers, 'SCIENTIFIC');
      expect(scientificMarkers.length).toBe(4);
    });
  });

  describe('getMarkerDefinition', () => {
    test('returns definition for STAGE', () => {
      const def = getMarkerDefinition('STAGE');
      expect(def).toBeDefined();
      expect(def?.category).toBe('WORKFLOW');
    });

    test('returns definition for CHECKPOINT', () => {
      const def = getMarkerDefinition('CHECKPOINT');
      expect(def).toBeDefined();
      expect(def?.category).toBe('WORKFLOW');
    });

    test('returns undefined for unknown marker', () => {
      const def = getMarkerDefinition('UNKNOWN');
      expect(def).toBeUndefined();
    });
  });

  describe('getMarkersByCategory', () => {
    test('returns WORKFLOW markers including STAGE and CHECKPOINT', () => {
      const text = `
[STAGE:begin:id=S01] Start
[CHECKPOINT:saved:id=ckpt-001] Saved
[INFO] Some info
[OBJECTIVE] Goal
`;
      const result = parseMarkers(text);
      const workflowMarkers = getMarkersByCategory(result.markers, 'WORKFLOW');
      
      expect(workflowMarkers.length).toBe(3);
      expect(workflowMarkers.map(m => m.type)).toContain('STAGE');
      expect(workflowMarkers.map(m => m.type)).toContain('CHECKPOINT');
      expect(workflowMarkers.map(m => m.type)).toContain('INFO');
    });
  });
});
