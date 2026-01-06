# Gyoshu User Guide

> From zero to research in 60 seconds

## Your First Research in 60 Seconds

**Prerequisites:**
- OpenCode installed ([get it here](https://github.com/opencode-ai/opencode))
- Gyoshu installed (add `"gyoshu"` to `plugin` array in `opencode.json`)

---

### Step 1: Create Python Environment (30 seconds)

Open your terminal and navigate to your project:

```bash
cd your-project
python3 -m venv .venv
.venv/bin/pip install pandas numpy scikit-learn matplotlib seaborn
```

**Expected output:**
```
Successfully installed pandas-2.0.3 numpy-1.24.0 scikit-learn-1.3.0 ...
```

---

### Step 2: Run Gyoshu Doctor (10 seconds)

Start OpenCode and verify your setup:

```bash
opencode
```

Then type:
```
/gyoshu doctor
```

**Expected output:**
```
Gyoshu Doctor - System Health Check

| Check | Status | Details |
|-------|--------|---------|
| OpenCode | Pass | Running in OpenCode context |
| Python | Pass | Python 3.11.5 |
| .venv | Pass | .venv/bin/python exists |
| Bridge | Pass | Bridge responded in 0.3s |

All required checks passed! Ready for research.
```

> **Troubleshooting:** If any check fails, see the [Troubleshooting](#troubleshooting) section below.

---

### Step 3: Start Your First Research (20 seconds)

Now the fun part! Start analyzing the wine quality dataset:

```
/gyoshu analyze wine quality factors in data/wine_quality.csv
```

**What happens:**
1. Gyoshu searches for similar prior research (finds none on first run)
2. Creates `notebooks/wine-quality.ipynb`
3. Jogyo (the TA) loads the data and starts analysis
4. You'll see structured output with `[OBJECTIVE]`, `[FINDING]`, `[METRIC]` markers

**Expected first output:**
```
No similar prior research found. Starting fresh.

Created notebook: notebooks/wine-quality.ipynb

[OBJECTIVE] Analyze wine quality factors from physicochemical properties
[DATA] Loaded wine_quality.csv: 1599 samples, 12 features
[HYPOTHESIS] Chemical properties correlate with wine quality ratings
```

---

## That's It!

You just:
- Set up your Python environment
- Verified Gyoshu is working
- Started your first AI-powered research

**What's next?**
- Let the research run and see what Jogyo discovers
- Check your notebook: `notebooks/wine-quality.ipynb`
- Generate a report: `/gyoshu report`

---

## Quick Reference

| Command | What It Does |
|---------|--------------|
| `/gyoshu` | Show status and suggestions |
| `/gyoshu <goal>` | Start interactive research |
| `/gyoshu-auto <goal>` | Autonomous mode (hands-off) |
| `/gyoshu continue` | Continue previous research |
| `/gyoshu doctor` | Diagnose setup issues |
| `/gyoshu report` | Generate research report |
| `/gyoshu list` | List all research projects |
| `/gyoshu search <query>` | Search across notebooks |

---

## Core Concepts

### Research Projects

A **research project** is a named investigation stored in `notebooks/`. Each project has:
- A unique **reportTitle** (slug like `wine-quality`, `churn-analysis`)
- One or more **runs** (execution sessions)
- A **notebook** (`notebooks/{reportTitle}.ipynb`) as the source of truth
- **Artifacts** in `reports/{reportTitle}/` (figures, models, exports)

### Runs

A **run** is a single execution session within a research project. Runs have:
- A unique **runId** (like `run-001`, `run-002`)
- A **mode**: `PLANNER` (interactive) or `AUTO` (autonomous)
- A **status**: `IN_PROGRESS`, `COMPLETED`, `BLOCKED`, or `ABORTED`
- All code cells executed during the run

### Notebooks

Gyoshu stores research as **Jupyter notebooks** with YAML frontmatter:
- Notebooks are the **source of truth** for your research
- Open them in Jupyter Lab, VS Code, or any notebook viewer
- All execution is captured with inputs and outputs
- Frontmatter tracks metadata (status, runs, tags)

### Output Markers

The TA (Jogyo) uses **structured markers** to organize research output:

| Marker | Purpose | Example |
|--------|---------|---------|
| `[OBJECTIVE]` | Research goal | `[OBJECTIVE] Predict wine quality` |
| `[HYPOTHESIS]` | What you're testing | `[HYPOTHESIS] Alcohol is key predictor` |
| `[DATA]` | Dataset info | `[DATA] Loaded 1599 samples` |
| `[METRIC:name]` | Quantitative result | `[METRIC:accuracy] 0.87` |
| `[FINDING]` | Key discovery | `[FINDING] Alcohol correlates at r=0.47` |
| `[CONCLUSION]` | Final verdict | `[CONCLUSION] Hypothesis supported` |

These markers help generate structured reports and enable searching across research.

---

## Workflows

### Interactive Mode

**Best for:** Exploring, learning, iterating on analysis

```
/gyoshu <your research goal>
```

In interactive mode:
1. You guide each step of the research
2. The Professor (Gyoshu) plans, you approve
3. The TA (Jogyo) executes your decisions
4. You can pause, adjust, and continue anytime

**Example:**
```
/gyoshu analyze customer churn patterns
```

### Autonomous Mode

**Best for:** Clear goals, hands-off execution

```
/gyoshu-auto <your research goal>
```

In autonomous mode:
1. Set a clear research goal
2. Gyoshu plans and executes without interruption
3. Baksa (PhD reviewer) verifies claims
4. You return to completed research with report

**Example:**
```
/gyoshu-auto build a classifier for iris species
```

### REPL Mode

**Best for:** Quick exploration, debugging, ad-hoc analysis

```
/gyoshu repl <your question>
```

In REPL mode:
1. Direct access to the Python environment
2. Variables from previous runs are available
3. Quick answers without creating new research

**Example:**
```
/gyoshu repl what columns does df have?
/gyoshu repl plot correlation matrix
/gyoshu repl run t-test between groups A and B
```

---

## Managing Research

### Continue Previous Research

Pick up where you left off:

```
/gyoshu continue
```

If you have multiple active projects, specify which one:

```
/gyoshu continue wine-quality
```

**What happens:**
- Loads the research context (goals, findings, artifacts)
- Restores REPL environment (variables, imports)
- Shows summary of previous runs
- Offers to resume from checkpoint (if available)

### List All Research

See all your research projects:

```
/gyoshu list
```

**Filter by status:**
```
/gyoshu list --status active
/gyoshu list --status completed
```

### Search Across Research

Find content across all notebooks:

```
/gyoshu search "machine learning"
/gyoshu search correlation --notebooks-only
```

**Search returns:**
- Matching research projects (by title, goal, tags)
- Matching notebook cells (code and markdown)

### Generate Reports

Create a summary report of your research:

```
/gyoshu report
```

For a specific project:
```
/gyoshu report wine-quality
```

**Report includes:**
- Executive summary with key findings
- Methodology and data sources
- All `[FINDING]` and `[METRIC]` markers
- Conclusions and recommended next steps

### Abort Research

Gracefully stop an in-progress research:

```
/gyoshu abort
```

**What happens:**
- Stops current execution
- Saves all work to notebook
- Marks run as `ABORTED`
- Can be resumed later with `/gyoshu continue`

---

## Troubleshooting

### "No .venv found"

Create a virtual environment:
```bash
python3 -m venv .venv
.venv/bin/pip install pandas numpy scikit-learn matplotlib seaborn
```

### "Bridge failed to start"

Check Python version (need 3.10+):
```bash
python3 --version
```

If outdated, install Python 3.10+:
- Ubuntu: `sudo apt install python3.10`
- macOS: `brew install python@3.10`

### "Session locked"

A previous session didn't exit cleanly. Unlock it:
```
/gyoshu unlock <sessionId>
```

### OpenCode not in PATH

Install OpenCode from [opencode-ai/opencode](https://github.com/opencode-ai/opencode).

---

## Learn More

- [AGENTS.md](../AGENTS.md) - Technical documentation for contributors
- [README.md](../README.md) - Project overview and features
- [Checkpoint System](stage-protocol.md) - Advanced: resumable research stages

---

<div align="center">

**Made with love by the Gyoshu team**

[Report Bug](https://github.com/Yeachan-Heo/My-Jogyo/issues) | [Request Feature](https://github.com/Yeachan-Heo/My-Jogyo/issues)

</div>
