# AI Todo List: Upgrade Gyoshu to Senior Data Scientist Quality

**Created**: 2026-01-04
**Goal**: Transform Gyoshu from "good EDA" (C+/B-) to "senior data scientist level" research output
**Core Insight**: Make it impossible to produce shallow findings by requiring statistical evidence before any [FINDING] is accepted

---

## Phase 1: Agent Prompt Upgrades (Quick Wins - <1 day)

### 1.1 Gyoshu Professor Upgrade
- [x] 1. Add Hypothesis Register requirement to `src/agent/gyoshu.md`
   - [x] 1.1 Add "Mandatory: Hypothesis Register" section after discovery phase
   - [x] 1.2 Define hypothesis register YAML format (H0/H1, endpoint, alpha, correction_plan)
   - [x] 1.3 Add required stages table: hypothesis_register, assumptions_check, test_and_effect, robustness
   - [x] 1.4 Add stage verification checklist for validating Jogyo output
   **Parallelizable**: YES (with Tasks 2, 3, 4)
   **Effort**: 30 min
   **File**: `src/agent/gyoshu.md`

### 1.2 Jogyo TA Upgrade
- [x] 2. Add statistical evidence markers to `src/agent/jogyo.md`
   - [x] 2.1 Add "Statistical Evidence Markers (MANDATORY)" section with new markers:
      - [DECISION] - Test selection with justification
      - [CHECK:*] - Assumption verification (normality, homogeneity, independence)
      - [STAT:estimate] - Point estimate
      - [STAT:ci] - Confidence interval
      - [STAT:effect_size] - Effect size with interpretation
      - [STAT:p_value] - P-value with context
      - [INDEPENDENT_CHECK] - Robustness verification
      - [SO_WHAT] - Practical significance explanation
      - [LIMITATION] - Threats to validity
   - [x] 2.2 Add "Finding Gating Rule" - CRITICAL: No [FINDING] without [STAT:ci] + [STAT:effect_size]
   - [x] 2.3 Add Python code templates for:
      - Assumption checking (Shapiro-Wilk, Levene's)
      - Effect size calculation (Cohen's d, r², odds ratio)
      - CI calculation (parametric and bootstrap)
   - [x] 2.4 Add "ML Pipeline Stages (MANDATORY)" section with required stages:
      - baseline: Dummy classifier benchmark
      - cv: Cross-validation with mean ± std
      - tuning: Hyperparameter search with distribution
      - calibration: Probability calibration check
      - interpretation: SHAP/permutation importance
      - error_analysis: Failure mode analysis
   - [x] 2.5 Add ML code templates for each stage
   **Parallelizable**: YES (with Tasks 1, 3, 4)
   **Effort**: 1 hour
   **File**: `src/agent/jogyo.md`

### 1.3 Baksa PhD Reviewer Upgrade
- [x] 3. Add statistical rigor challenges to `src/agent/baksa.md`
   - [x] 3.1 Add "Statistical Rigor Checklist (MANDATORY)" section with fail triggers:
      - Missing H0/H1 → FAIL
      - Missing CI → FAIL
      - Missing effect size → FAIL
      - Missing multiple testing correction → FAIL (if >1 test)
   - [x] 3.2 Add automatic rejection triggers (trust score -30):
      - [FINDING] without [STAT:ci]
      - [FINDING] without [STAT:effect_size]
      - "Significant" claim without p-value
      - Correlation without scatterplot
   - [x] 3.3 Add "ML-Specific Challenges (MANDATORY)" section:
      - Baseline Challenge: "What's the dummy baseline?"
      - CV Challenge: "Show variance across folds"
      - Leakage Challenge: "Preprocessing before or after split?"
      - Interpretation Challenge: "Top 3 features and domain sense?"
   - [x] 3.4 Add ML trust score penalties table:
      - No baseline: -20
      - No CV: -25
      - No interpretation: -15
      - Train-test gap >10%: -20
   **Parallelizable**: YES (with Tasks 1, 2, 4)
   **Effort**: 45 min
   **File**: `src/agent/baksa.md`

### 1.4 Jogyo Paper Writer Upgrade
- [x] 4. Add IMRAD structure to `src/agent/jogyo-paper-writer.md`
   - [x] 4.1 Add "IMRAD Report Structure (MANDATORY)" section:
      - Introduction: Research question, context
      - Methods: Data, tests, assumptions
      - Results: Effect sizes + CIs (verified findings only)
      - Analysis/Discussion: So What, limitations
      - Conclusion: Answer + recommendations
   - [x] 4.2 Add finding categorization rules:
      - Verified Findings: trust score ≥ 80
      - Partial Findings: trust score 60-79
      - Exploratory Notes: trust score < 60
   - [x] 4.3 Add "So What Integration (MANDATORY)" with transformation examples
   - [x] 4.4 Add "Limitations Section" requirements
   **Parallelizable**: YES (with Tasks 1, 2, 3)
   **Effort**: 30 min
   **File**: `src/agent/jogyo-paper-writer.md`

### 1.5 Update AGENTS.md Documentation
- [x] 5. Add new markers to `AGENTS.md`
   - [x] 5.1 Add "Statistical Evidence Markers" table
   - [x] 5.2 Add "ML Pipeline Markers" table
   - [x] 5.3 Add "Research Quality Standards" section
   - [x] 5.4 Update marker examples with new format
   **Parallelizable**: NO (depends on Tasks 1-4)
   **Effort**: 20 min
   **File**: `AGENTS.md`

---

## Phase 2: Quality Gate System (1-2 days)

### 2.1 Create Quality Gates Library
- [ ] 6. Create `src/lib/quality-gates.ts`
   - [ ] 6.1 Define interfaces: QualityViolation, QualityGateResult
   - [ ] 6.2 Implement validateFindings():
      - Scan for [FINDING] markers
      - Check for nearby [STAT:ci] (within 5 lines)
      - Check for nearby [STAT:effect_size] (within 5 lines)
      - Return violations for missing evidence
   - [ ] 6.3 Implement validateMLPipeline():
      - Check for baseline metrics
      - Check for CV metrics
      - Check for interpretation markers
   - [ ] 6.4 Implement runQualityGates():
      - Read notebook
      - Extract stdout from code cells
      - Run both validators
      - Calculate overall score
   **Parallelizable**: NO (foundational)
   **Effort**: 2 hours
   **File**: `src/lib/quality-gates.ts`

### 2.2 Create Quality Gates Tests
- [ ] 7. Create `src/lib/quality-gates.test.ts`
   - [ ] 7.1 Test: Finding with all stats → passes
   - [ ] 7.2 Test: Finding without CI → fails
   - [ ] 7.3 Test: Finding without effect size → fails
   - [ ] 7.4 Test: ML metrics without baseline → fails
   - [ ] 7.5 Test: ML metrics without CV → fails
   - [ ] 7.6 Test: Score calculation accuracy
   **Parallelizable**: YES (with Task 8)
   **Effort**: 1 hour
   **File**: `src/lib/quality-gates.test.ts`

### 2.3 Update Marker Parser
- [ ] 8. Extend `src/lib/marker-parser.ts` for new markers
   - [ ] 8.1 Add STAT marker type with subtypes (ci, effect_size, p_value, estimate)
   - [ ] 8.2 Add DECISION, CHECK, SO_WHAT, LIMITATION, INDEPENDENT_CHECK types
   - [ ] 8.3 Add ML marker type with subtypes (baseline, cv_result, tuning, etc.)
   - [ ] 8.4 Add getMarkersByType() helper function
   - [ ] 8.5 Update tests for new markers
   **Parallelizable**: YES (with Task 7)
   **Effort**: 1 hour
   **File**: `src/lib/marker-parser.ts`

### 2.4 Integrate into Completion Tool
- [ ] 9. Update `src/tool/gyoshu-completion.ts`
   - [ ] 9.1 Import runQualityGates from quality-gates.ts
   - [ ] 9.2 Add quality gate check before SUCCESS status
   - [ ] 9.3 Downgrade SUCCESS → PARTIAL if quality gates fail
   - [ ] 9.4 Add quality_score and violations to result
   - [ ] 9.5 Add unverified_findings list to evidence
   **Parallelizable**: NO (depends on Tasks 6, 8)
   **Effort**: 1 hour
   **File**: `src/tool/gyoshu-completion.ts`

### 2.5 Update Report Generation
- [ ] 10. Update `src/lib/report-markdown.ts`
   - [ ] 10.1 Import quality gates
   - [ ] 10.2 Add separateFindings(): verified vs unverified
   - [ ] 10.3 Add "Verified Findings" section to template
   - [ ] 10.4 Add "Exploratory Observations" section for unverified
   - [ ] 10.5 Add required sections validation (IMRAD)
   - [ ] 10.6 Add [SECTION MISSING] placeholders for absent sections
   **Parallelizable**: NO (depends on Task 6)
   **Effort**: 1.5 hours
   **File**: `src/lib/report-markdown.ts`

---

## Phase 3: Templates & Skills (1-2 days)

### 3.1 Create ML Rigor Skill
- [ ] 11. Create `src/skill/ml-rigor/SKILL.md`
   - [ ] 11.1 Baseline Requirements section:
      - Always compare to DummyClassifier/DummyRegressor
      - Always compare to simple linear model
      - Report improvement over baseline with CI
   - [ ] 11.2 Cross-Validation Requirements section:
      - Use stratified K-fold for classification
      - Report mean ± std, not just mean
      - Calculate CI for mean performance
   - [ ] 11.3 Hyperparameter Tuning section:
      - Use RandomizedSearchCV or Bayesian
      - Report distribution of scores, not just best
      - Avoid overfitting to validation set
   - [ ] 11.4 Calibration Requirements section:
      - Check calibration curve for probabilities
      - Report Brier score
      - Consider calibration if needed
   - [ ] 11.5 Interpretation Requirements section:
      - Permutation importance or SHAP
      - At least one case study (why this prediction?)
      - Verify features make domain sense
   - [ ] 11.6 Error Analysis section:
      - Slice performance by key segments
      - Analyze failure modes
      - Check for systematic errors
   - [ ] 11.7 Leakage Checklist:
      - Time-based splits for temporal data
      - No target information in features
      - Preprocessing inside CV loop
   **Parallelizable**: YES (with Tasks 12, 13, 14)
   **Effort**: 1.5 hours
   **File**: `src/skill/ml-rigor/SKILL.md`

### 3.2 Update Scientific Method Skill
- [ ] 12. Update `src/skill/scientific-method/SKILL.md`
   - [ ] 12.1 Add "Hypothesis-First Workflow" section:
      - State H0/H1 before looking at data
      - Define endpoints and alpha before analysis
      - Pre-register analysis plan
   - [ ] 12.2 Add "Statistical Rigor Requirements" section:
      - Always report CI, not just point estimate
      - Always report effect size with interpretation
      - Use appropriate test for data type
   - [ ] 12.3 Add "Multiple Comparison Correction" guide:
      - Bonferroni for small number of tests
      - BH-FDR for larger sets
      - Report both raw and adjusted p-values
   - [ ] 12.4 Add "Effect Size Interpretation" table:
      - Cohen's d: 0.2 small, 0.5 medium, 0.8 large
      - r: 0.1 small, 0.3 medium, 0.5 large
      - Odds ratio: 1.5 small, 2.5 medium, 4.0 large
   **Parallelizable**: YES (with Tasks 11, 13, 14)
   **Effort**: 1 hour
   **File**: `src/skill/scientific-method/SKILL.md`

### 3.3 Update Data Analysis Skill
- [ ] 13. Update `src/skill/data-analysis/SKILL.md`
   - [ ] 13.1 Add "Confidence Interval Patterns" section:
      - Parametric CI for means
      - Bootstrap CI for medians/complex stats
      - Wilson CI for proportions
   - [ ] 13.2 Add "Effect Size Calculation" code templates:
      - Cohen's d for group comparisons
      - r² for correlations
      - Cliff's delta for non-parametric
   - [ ] 13.3 Add "Assumption Checking" patterns:
      - Normality: Shapiro-Wilk, Q-Q plot
      - Homogeneity: Levene's test
      - Independence: Durbin-Watson
   - [ ] 13.4 Add "Robust Alternatives" section:
      - Welch's t-test instead of Student's
      - Mann-Whitney for non-normal
      - Permutation tests for complex designs
   **Parallelizable**: YES (with Tasks 11, 12, 14)
   **Effort**: 1 hour
   **File**: `src/skill/data-analysis/SKILL.md`

### 3.4 Update Experiment Design Skill
- [ ] 14. Update `src/skill/experiment-design/SKILL.md`
   - [ ] 14.1 Add "Power Analysis" section:
      - Calculate required sample size
      - Use G*Power or statsmodels
      - Report achieved power
   - [ ] 14.2 Add "Pre-registration Concept":
      - Define analysis before seeing data
      - Distinguish confirmatory vs exploratory
      - Document deviations from plan
   - [ ] 14.3 Add "Stopping Rules":
      - Define success/failure criteria upfront
      - Avoid p-hacking through optional stopping
      - Consider sequential analysis methods
   **Parallelizable**: YES (with Tasks 11, 12, 13)
   **Effort**: 45 min
   **File**: `src/skill/experiment-design/SKILL.md`

---

## Phase 4: Literature Integration MVP (2-3 days)

### 4.1 Create Literature Client
- [ ] 15. Create `src/lib/literature-client.ts`
   - [ ] 15.1 Define interfaces: Citation, SearchResult, LiteratureCache
   - [ ] 15.2 Implement cache layer (JSON file in reports dir)
   - [ ] 15.3 Implement Crossref API client:
      - DOI → BibTeX/metadata
      - Title search → DOI list
      - Rate limiting (1 req/sec)
   - [ ] 15.4 Implement arXiv API client:
      - Keyword search
      - Abstract retrieval
      - PDF URL extraction
   - [ ] 15.5 Implement Semantic Scholar client (optional, needs API key):
      - Related papers
      - Citation context
   - [ ] 15.6 Add retry logic and error handling
   **Parallelizable**: NO (foundational for Phase 4)
   **Effort**: 3 hours
   **File**: `src/lib/literature-client.ts`

### 4.2 Create Literature Search Tool
- [ ] 16. Create `src/tool/literature-search.ts`
   - [ ] 16.1 Define tool schema: query, source (crossref/arxiv/semantic_scholar), limit
   - [ ] 16.2 Implement search action:
      - Search across configured sources
      - Return: title, authors, year, abstract, DOI, URL
      - Cache results locally
   - [ ] 16.3 Implement cite action:
      - DOI/arXiv ID → formatted citation
      - Support APA, BibTeX formats
   - [ ] 16.4 Implement related action:
      - Find papers related to current research
      - Extract baseline metrics if available
   **Parallelizable**: NO (depends on Task 15)
   **Effort**: 2 hours
   **File**: `src/tool/literature-search.ts`

### 4.3 Add Citation Marker Support
- [ ] 17. Add [CITATION] marker to system
   - [ ] 17.1 Update marker-parser.ts to recognize [CITATION:doi] format
   - [ ] 17.2 Update report-markdown.ts to resolve citations
   - [ ] 17.3 Add References section to report template
   - [ ] 17.4 Update Jogyo prompt with citation examples
   **Parallelizable**: NO (depends on Task 16)
   **Effort**: 1 hour
   **Files**: Multiple

### 4.4 Integrate Citations into Baksa
- [ ] 18. Update Baksa to challenge uncited claims
   - [ ] 18.1 Add "Known Results" challenge: "Source for this claim?"
   - [ ] 18.2 Add "Baseline Reference" challenge for ML: "Published baseline for this dataset?"
   - [ ] 18.3 Add trust score penalty (-10) for uncited "known" claims
   **Parallelizable**: NO (depends on Tasks 16, 17)
   **Effort**: 30 min
   **File**: `src/agent/baksa.md`

---

## Phase 5: Testing & Validation (1-2 days)

### 5.1 Create Integration Tests
- [ ] 19. Create quality gate integration tests
   - [ ] 19.1 Test full pipeline with good research → SUCCESS
   - [ ] 19.2 Test full pipeline with shallow research → PARTIAL
   - [ ] 19.3 Test finding categorization in reports
   - [ ] 19.4 Test IMRAD section validation
   **Parallelizable**: NO (depends on all previous phases)
   **Effort**: 2 hours
   **File**: `tests/quality-gates-integration.test.ts`

### 5.2 Run Validation Research
- [ ] 20. Run example research to validate improvements
   - [ ] 20.1 Run /gyoshu-auto with titanic dataset
   - [ ] 20.2 Verify hypothesis register is created
   - [ ] 20.3 Verify statistical markers are used
   - [ ] 20.4 Verify quality gates catch missing evidence
   - [ ] 20.5 Verify report has IMRAD structure
   - [ ] 20.6 Compare output quality to baseline (COVID example)
   **Parallelizable**: NO (requires all changes)
   **Effort**: 2 hours
   **Manual task**

### 5.3 Update Documentation
- [ ] 21. Document new workflow in AGENTS.md
   - [ ] 21.1 Add "Research Quality Standards" section
   - [ ] 21.2 Add "Quality Gates" explanation
   - [ ] 21.3 Update marker reference tables
   - [ ] 21.4 Add examples of good vs bad findings
   **Parallelizable**: NO (depends on validation)
   **Effort**: 1 hour
   **File**: `AGENTS.md`

- [ ] 22. Update README with research quality section
   - [ ] 22.1 Add "Research Quality" section explaining rigor
   - [ ] 22.2 Add quality standards table
   - [ ] 22.3 Update examples with new marker format
   **Parallelizable**: YES (with Task 21)
   **Effort**: 30 min
   **File**: `README.md`

---

## Success Criteria

- [ ] Every [FINDING] has supporting [STAT:ci] + [STAT:effect_size]
- [ ] ML outputs include baseline comparison + interpretation
- [ ] Reports have all IMRAD sections (or explicit [SECTION MISSING])
- [ ] Baksa rejects findings without statistical rigor (trust < 80)
- [ ] Quality gates prevent shallow research from completing as SUCCESS
- [ ] New research output demonstrates improvement over COVID example

---

## Dependency Graph

```
Phase 1 (Parallel):
┌─────────┬─────────┬─────────┬─────────┐
│ Task 1  │ Task 2  │ Task 3  │ Task 4  │
│ Gyoshu  │ Jogyo   │ Baksa   │ Writer  │
└────┬────┴────┬────┴────┬────┴────┬────┘
     │         │         │         │
     └─────────┴────┬────┴─────────┘
                    ▼
              ┌─────────┐
              │ Task 5  │ AGENTS.md
              └────┬────┘
                   │
Phase 2:           ▼
              ┌─────────┐
              │ Task 6  │ quality-gates.ts
              └────┬────┘
         ┌─────────┼─────────┐
         ▼         ▼         ▼
    ┌─────────┬─────────┬─────────┐
    │ Task 7  │ Task 8  │         │
    │ Tests   │ Parser  │         │
    └────┬────┴────┬────┘         │
         │         │              │
         └────┬────┘              │
              ▼                   │
         ┌─────────┐              │
         │ Task 9  │ completion   │
         └────┬────┘              │
              │                   │
              ▼                   ▼
         ┌─────────────────────────┐
         │       Task 10          │ report-markdown
         └───────────┬────────────┘
                     │
Phase 3 (Parallel):  │
┌─────────┬─────────┬┴────────┬─────────┐
│ Task 11 │ Task 12 │ Task 13 │ Task 14 │
│ ML Skill│ Sci.Mth │ Data An │ Exp.Des │
└─────────┴─────────┴─────────┴─────────┘
                     │
Phase 4:             ▼
              ┌─────────┐
              │ Task 15 │ literature-client
              └────┬────┘
                   ▼
              ┌─────────┐
              │ Task 16 │ literature-search
              └────┬────┘
                   ▼
              ┌─────────┐
              │ Task 17 │ citation markers
              └────┬────┘
                   ▼
              ┌─────────┐
              │ Task 18 │ Baksa citations
              └────┬────┘
                   │
Phase 5:           ▼
         ┌─────────────────────────┐
         │ Tasks 19-22: Testing   │
         └─────────────────────────┘
```

---

## Estimated Total Effort

| Phase | Tasks | Parallel? | Effort |
|-------|-------|-----------|--------|
| Phase 1 | 1-5 | Yes (1-4) | 3 hours |
| Phase 2 | 6-10 | Partial | 6.5 hours |
| Phase 3 | 11-14 | Yes | 4.25 hours |
| Phase 4 | 15-18 | No | 6.5 hours |
| Phase 5 | 19-22 | Partial | 5.5 hours |
| **Total** | 22 tasks | - | **~26 hours** |

With parallelization: **~3-4 days** of focused work.
