---
name: scientific-method
description: Framework for hypothesis-driven scientific research
---

# Scientific Method Framework

## When to Use
Load this skill when conducting hypothesis-driven research that requires rigorous methodology.

## The Scientific Method

### 1. Observation
- Examine existing data or phenomena
- Note patterns, anomalies, or questions
- Document initial observations with `[OBSERVATION]` marker

### 2. Question
- Formulate a specific, testable question
- Use `[OBJECTIVE]` marker to state clearly

### 3. Hypothesis
- Propose a testable explanation
- Make specific, falsifiable predictions
- Use `[HYPOTHESIS]` marker

### 4. Experiment
- Design controlled experiments
- Identify variables (independent, dependent, controlled)
- Use `[EXPERIMENT]` marker for procedures

### 5. Analysis
- Collect and analyze data
- Use statistical methods appropriately
- Use `[ANALYSIS]` marker for interpretations

### 6. Conclusion
- Accept or reject hypothesis based on evidence
- Acknowledge limitations
- Use `[CONCLUSION:confidence=X]` marker

## Best Practices

1. **Null Hypothesis**: Always consider the null hypothesis
2. **Controls**: Include appropriate control groups/conditions
3. **Sample Size**: Ensure adequate sample size for statistical power
4. **Reproducibility**: Document all steps for replication
5. **Peer Review**: Validate findings before final conclusions

---

## Hypothesis-First Workflow

**CRITICAL**: State your hypotheses BEFORE looking at the data. This prevents p-hacking and confirmation bias.

### 1. State H0/H1 Before Data Analysis

```python
# ALWAYS document hypotheses before running analysis
print("[HYPOTHESIS] H0: No difference between groups (μ1 = μ2)")
print("[HYPOTHESIS] H1: Treatment group shows improvement (μ1 > μ2)")
```

**Requirements:**
- H0 (Null Hypothesis): The default assumption of no effect/difference
- H1 (Alternative Hypothesis): The specific effect you're testing
- Both must be stated BEFORE examining the data

### 2. Define Endpoints and Alpha Before Analysis

```python
# Pre-specify statistical parameters
print("[DECISION] Primary endpoint: mean response time")
print("[DECISION] Alpha level: 0.05 (two-tailed)")
print("[DECISION] Minimum effect size of interest: Cohen's d = 0.5")
```

**Before running any tests, document:**
- Primary endpoint (what you're measuring)
- Alpha level (typically 0.05)
- Directionality (one-tailed vs two-tailed)
- Minimum effect size of practical significance

### 3. Pre-registration

Document your complete analysis plan before data analysis:

```markdown
## Pre-Registration
- **Primary Hypothesis**: [H0/H1 statements]
- **Primary Endpoint**: [What metric]
- **Statistical Test**: [Which test and why]
- **Alpha Level**: [Significance threshold]
- **Sample Size Rationale**: [Power analysis results]
- **Multiple Testing**: [Correction method if >1 test]
- **Exclusion Criteria**: [When to remove data points]
```

**Why Pre-register?**
- Distinguishes confirmatory from exploratory analysis
- Prevents HARKing (Hypothesizing After Results are Known)
- Increases credibility of findings

---

## Statistical Rigor Requirements

### Always Report Confidence Intervals

**NEVER** report only point estimates. Always include confidence intervals:

```python
# Calculate and report CI
from scipy.stats import sem
mean_val = data.mean()
ci_margin = 1.96 * sem(data)
ci_low, ci_high = mean_val - ci_margin, mean_val + ci_margin

print(f"[STAT:estimate] Mean = {mean_val:.3f}")
print(f"[STAT:ci] 95% CI [{ci_low:.3f}, {ci_high:.3f}]")
```

**CI communicates:**
- Precision of the estimate
- Range of plausible values
- Whether effect is meaningfully different from zero

### Always Report Effect Size with Interpretation

**NEVER** claim significance without effect size:

```python
import numpy as np

def cohens_d(group1, group2):
    n1, n2 = len(group1), len(group2)
    var1, var2 = group1.var(), group2.var()
    pooled_std = np.sqrt(((n1-1)*var1 + (n2-1)*var2) / (n1+n2-2))
    return (group1.mean() - group2.mean()) / pooled_std

d = cohens_d(treatment, control)
effect_label = "small" if abs(d) < 0.5 else "medium" if abs(d) < 0.8 else "large"
print(f"[STAT:effect_size] Cohen's d = {d:.3f} ({effect_label})")
```

### Use Appropriate Tests for Data Type

| Data Type | Comparison | Recommended Test |
|-----------|------------|------------------|
| Continuous, normal | 2 groups | Welch's t-test |
| Continuous, non-normal | 2 groups | Mann-Whitney U |
| Continuous, normal | >2 groups | ANOVA |
| Continuous, non-normal | >2 groups | Kruskal-Wallis |
| Categorical | 2x2 table | Chi-square or Fisher's exact |
| Proportions | 2 groups | Z-test for proportions |
| Correlation | Continuous | Pearson (normal) or Spearman |

```python
# Document test selection
print("[DECISION] Using Welch's t-test: two independent groups, unequal variance assumed")

# Check assumptions
from scipy.stats import shapiro, levene
_, p_norm = shapiro(data)
print(f"[CHECK:normality] Shapiro-Wilk p = {p_norm:.3f}")
```

---

## Multiple Comparison Correction

When running multiple statistical tests, adjust for inflated false positive rate.

### Bonferroni Correction (Conservative)

**Use when:** Small number of planned comparisons (≤10)

```python
import numpy as np

n_tests = 5
alpha = 0.05
bonferroni_alpha = alpha / n_tests

print(f"[DECISION] Bonferroni correction: α = {alpha}/{n_tests} = {bonferroni_alpha:.4f}")

# Report both raw and adjusted p-values
p_values = [0.01, 0.03, 0.02, 0.15, 0.04]
for i, p in enumerate(p_values):
    adjusted_p = min(p * n_tests, 1.0)
    sig = "***" if p < bonferroni_alpha else ""
    print(f"[STAT:p_value] Test {i+1}: raw p = {p:.4f}, adjusted p = {adjusted_p:.4f} {sig}")
```

### Benjamini-Hochberg FDR (Less Conservative)

**Use when:** Large number of tests (>10), exploratory analysis

```python
from scipy.stats import false_discovery_control

p_values = np.array([0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.35])
adjusted_p = false_discovery_control(p_values, method='bh')

print("[DECISION] Benjamini-Hochberg FDR correction for 10 tests")
for i, (raw, adj) in enumerate(zip(p_values, adjusted_p)):
    sig = "***" if adj < 0.05 else ""
    print(f"[STAT:p_value] Test {i+1}: raw p = {raw:.4f}, BH-adjusted p = {adj:.4f} {sig}")
```

### Decision Guide

| Scenario | Correction | Rationale |
|----------|------------|-----------|
| 1-5 planned comparisons | Bonferroni | Simple, conservative |
| 6-20 tests | Bonferroni or BH-FDR | Balance rigor/power |
| >20 tests (genomics, etc.) | BH-FDR | Maintains power |
| Exploratory screening | BH-FDR | Focus on discovery |
| Confirmatory study | Bonferroni | Focus on rigor |

**Always report both raw AND adjusted p-values** to allow readers to assess significance under different criteria.

---

## Effect Size Interpretation

Use these thresholds to interpret effect magnitudes:

### Cohen's d (Group Differences)

| Cohen's d | Interpretation | Practical Meaning |
|-----------|----------------|-------------------|
| 0.2 | Small | Barely noticeable difference |
| 0.5 | Medium | Noticeable, potentially meaningful |
| 0.8 | Large | Obvious, substantial difference |

```python
d = 0.65
if abs(d) < 0.2:
    interpretation = "negligible"
elif abs(d) < 0.5:
    interpretation = "small"
elif abs(d) < 0.8:
    interpretation = "medium"
else:
    interpretation = "large"

print(f"[STAT:effect_size] Cohen's d = {d:.2f} ({interpretation})")
```

### Correlation Coefficient (r)

| |r| | Interpretation | Variance Explained |
|-----|----------------|-------------------|
| 0.1 | Small | ~1% |
| 0.3 | Medium | ~9% |
| 0.5 | Large | ~25% |

```python
r = 0.42
r_squared = r ** 2
if abs(r) < 0.1:
    interpretation = "negligible"
elif abs(r) < 0.3:
    interpretation = "small"
elif abs(r) < 0.5:
    interpretation = "medium"
else:
    interpretation = "large"

print(f"[STAT:effect_size] r = {r:.2f} ({interpretation}, explains {r_squared*100:.1f}% variance)")
```

### Odds Ratio (OR)

| Odds Ratio | Interpretation |
|------------|----------------|
| 1.5 | Small effect |
| 2.5 | Medium effect |
| 4.0 | Large effect |

**Note:** Odds ratios are symmetric around 1.0. An OR of 0.25 is equivalent in magnitude to OR of 4.0.

```python
OR = 3.2
if OR > 1:
    if OR < 1.5:
        interpretation = "negligible"
    elif OR < 2.5:
        interpretation = "small"
    elif OR < 4.0:
        interpretation = "medium"
    else:
        interpretation = "large"
else:
    # For protective effects (OR < 1)
    reciprocal = 1 / OR
    if reciprocal < 1.5:
        interpretation = "negligible"
    elif reciprocal < 2.5:
        interpretation = "small"
    elif reciprocal < 4.0:
        interpretation = "medium"
    else:
        interpretation = "large"

print(f"[STAT:effect_size] OR = {OR:.2f} ({interpretation})")
```

### Quick Reference Table

| Measure | Small | Medium | Large |
|---------|-------|--------|-------|
| **Cohen's d** | 0.2 | 0.5 | 0.8 |
| **Correlation r** | 0.1 | 0.3 | 0.5 |
| **Odds Ratio** | 1.5 | 2.5 | 4.0 |
| **R² (variance)** | 1% | 9% | 25% |
| **η² (eta squared)** | 0.01 | 0.06 | 0.14 |

### From Effect Size to Practical Significance

Always translate statistical effect size to real-world meaning:

```python
# Good: Connect to practical significance
print(f"[STAT:effect_size] Cohen's d = 0.5 (medium)")
print(f"[SO_WHAT] A medium effect means the treatment reduces wait time by ~15 seconds on average")

# Bad: Just reporting the number
print(f"[STAT:effect_size] d = 0.5")  # Missing interpretation and practical meaning
```
